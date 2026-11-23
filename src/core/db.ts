import { DEFAULT_SETTINGS } from './types';
import type { AppData, Attempt, Calibration, DailyActivity, KeyJudgement, Phrase, Rect, ScoreReview, Session, Settings, Source, StrokeSample } from './types';
import { normalizeRoman } from './romaji';
import { isErrorTerminatedAttempt } from './analytics';
import { compatibleAttemptWithPhrase, compatiblePhraseAttempt, groupDuplicatePhrases, mergePhraseGroup, phraseSeenSources, phraseSnapshot } from './phrase-dedupe';
import { MAX_ACTIVITY_DAYS, MAX_ACTIVITY_KEYS, MAX_ACTIVITY_MS, MAX_ACTIVITY_PHRASES, mergeDailyActivity, validTrainingDate } from './activity';
const DB_NAME='uchikomi-v1', VERSION=3;
const STORE_NAMES=['phrases','attempts','sessions','settings','phraseAliases'] as const;
let database:Promise<IDBDatabase>|undefined;
const listeners=new Set<()=>void>();
let channel:BroadcastChannel|undefined;
function changes(){
  if(!channel&&typeof BroadcastChannel!=='undefined'&&typeof indexedDB!=='undefined'){
    channel=new BroadcastChannel('uchikomi-changes');channel.onmessage=()=>listeners.forEach(fn=>fn());
  }
  return channel;
}
function notify(){listeners.forEach(fn=>fn());changes()?.postMessage({changedAt:Date.now()});}
export function subscribe(onChange:()=>void):()=>void {listeners.add(onChange);changes();return ()=>listeners.delete(onChange);}
function db():Promise<IDBDatabase> {
  if(database)return database;
  database=new Promise((resolve,reject)=>{
    if(typeof indexedDB==='undefined'){reject(new Error('このブラウザではデータ保存を利用できません。'));return;}
    const request=indexedDB.open(DB_NAME,VERSION);
    let upgradeError:unknown,abandoned=false;
    request.onupgradeneeded=event=>{
      const result=request.result,tx=request.transaction!;
      const abort=(error:unknown)=>{upgradeError=error;tx.abort();};
      try{
        if(!result.objectStoreNames.contains('phrases'))result.createObjectStore('phrases',{keyPath:'id'});
        const attempts=result.objectStoreNames.contains('attempts')?tx.objectStore('attempts'):result.createObjectStore('attempts',{keyPath:'id'});
        if(!attempts.indexNames.contains('phraseId'))attempts.createIndex('phraseId','phraseId');
        if(!attempts.indexNames.contains('sessionId'))attempts.createIndex('sessionId','sessionId');
        if(!result.objectStoreNames.contains('sessions'))result.createObjectStore('sessions',{keyPath:'id'});
        if(!result.objectStoreNames.contains('settings'))result.createObjectStore('settings');
        const aliases=result.objectStoreNames.contains('phraseAliases')?tx.objectStore('phraseAliases'):result.createObjectStore('phraseAliases',{keyPath:'id'});
        if(!aliases.indexNames.contains('phraseId'))aliases.createIndex('phraseId','phraseId');
        if(event.oldVersion>0&&event.oldVersion<2){
          // The versionchange transaction commits all converted scores/settings
          // together. Phrase images and physical input records are untouched.
          const cursor=tx.objectStore('sessions').openCursor();
          cursor.onsuccess=()=>{
            const row=cursor.result;if(!row)return;
            try{row.update(migrateSessionToTotal(row.value));row.continue();}catch(error){abort(error);}
          };
          const settings=tx.objectStore('settings'),stored=settings.get('main');
          stored.onsuccess=()=>{
            if(stored.result===undefined)return;
            try{settings.put(migrateSettingsToTotal({...DEFAULT_SETTINGS,...stored.result}),'main');}catch(error){abort(error);}
          };
        }
        if(event.oldVersion>0&&event.oldVersion<3){
          const rows=tx.objectStore('phrases').getAll();
          rows.onsuccess=()=>{
            const values=rows.result as Phrase[];
            void consolidatePhrases(tx,values,new Map(values.map(phrase=>[phrase.id,phrase]))).catch(abort);
          };
        }
      }catch(error){abort(error);}
    };
    request.onerror=()=>{database=undefined;reject(upgradeError??request.error??new Error('データを開けませんでした。'));};
    request.onblocked=()=>{abandoned=true;database=undefined;reject(new Error('別のUCHIKOMI画面を閉じて再度お試しください。'));};
    request.onsuccess=()=>{const result=request.result;if(abandoned){result.close();return;}result.onversionchange=()=>{result.close();database=undefined;};resolve(result);};
  });return database;
}
function request<T>(req:IDBRequest<T>):Promise<T>{return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function complete(tx:IDBTransaction):Promise<void>{return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error??new Error('保存できませんでした。'));tx.onabort=()=>reject(tx.error??new Error('保存が中断されました。'));});}
export async function getData():Promise<AppData> {
  const database=await db(),tx=database.transaction([...STORE_NAMES],'readonly'),done=complete(tx);
  const [phrases,attempts,sessions,settings]=await Promise.all([
    request<Phrase[]>(tx.objectStore('phrases').getAll()),request<Attempt[]>(tx.objectStore('attempts').getAll()),request<Session[]>(tx.objectStore('sessions').getAll()),request<Settings|undefined>(tx.objectStore('settings').get('main')),
  ]);await done;
  return {phrases:phrases.sort((a,b)=>b.lastSeenAt-a.lastSeenAt),attempts:attempts.sort((a,b)=>a.startedAt-b.startedAt),sessions:sessions.sort((a,b)=>a.startedAt-b.startedAt),settings:{...DEFAULT_SETTINGS,...settings}};
}
/** Auto-discovery reads only preferences, never the growing image/history stores. */
export async function getSettings():Promise<Settings> {
  const database=await db(),tx=database.transaction('settings','readonly'),done=complete(tx);
  const settings=await request<Settings|undefined>(tx.objectStore('settings').get('main'));await done;
  return {...DEFAULT_SETTINGS,...settings};
}
interface Consolidation {phrases:Phrase[];bySource:Map<string,Phrase>;}
async function consolidatePhrases(tx:IDBTransaction,rows:Phrase[],previous:Map<string,Phrase>,changedIds?:ReadonlySet<string>,replacedAttemptIds?:ReadonlySet<string>):Promise<Consolidation> {
  const groups=groupDuplicatePhrases(rows),phrases:Phrase[]=[],bySource=new Map<string,Phrase>();
  const plans=groups.map(group=>{
    // Existing IDs stay stable when a fresh capture or an older backup arrives.
    const existing=group.filter(phrase=>previous.has(phrase.id)).sort((a,b)=>a.capturedAt-b.capturedAt||a.id.localeCompare(b.id));
    const merged=validatePhrase(mergePhraseGroup(group,existing[0]?.id));
    phrases.push(merged);
    for(const source of phraseSeenSources(merged)){
      const owner=bySource.get(source.id);
      if(owner&&owner.id!==merged.id)throw new Error('同じ元IDに異なる語句があるため、統合できません。');
      bySource.set(source.id,merged);
    }
    bySource.set(merged.id,merged);
    return {group,merged};
  });
  const store=tx.objectStore('phrases'),attempts=tx.objectStore('attempts'),aliases=tx.objectStore('phraseAliases');
  for(const {group,merged} of plans){
    if(changedIds&&group.length===1&&!changedIds.has(group[0].id))continue;
    store.put(merged);
    for(const source of phraseSeenSources(merged))aliases.put({id:source.id,phraseId:merged.id});
    aliases.put({id:merged.id,phraseId:merged.id});
    for(const member of group){
      if(member.id!==merged.id)store.delete(member.id);
      const before=previous.get(member.id)??member;
      if(member.id===merged.id&&!spellingChanged(before,merged))continue;
      const history=await request<Attempt[]>(attempts.index('phraseId').getAll(member.id));
      for(const attempt of history){
        const reliable=attempt.reliable&&(replacedAttemptIds?.has(attempt.id)||compatiblePhraseAttempt(before,merged,attempt));
        if(attempt.phraseId!==merged.id||reliable!==attempt.reliable)attempts.put({...attempt,phraseId:merged.id,reliable});
      }
    }
  }
  return {phrases,bySource};
}
export async function savePhrase(value:Phrase):Promise<Phrase> {
  const phrase=validatePhrase(value),database=await db(),tx=database.transaction(['phrases','attempts','phraseAliases'],'readwrite'),done=complete(tx),store=tx.objectStore('phrases');
  try{
    const all=await request<Phrase[]>(store.getAll()),previous=new Map(all.map(row=>[row.id,row]));
    const sameId=all.find(row=>row.id===phrase.id||row.seenSources?.some(source=>source.id===phrase.id));
    const matches=sameId?[]:groupDuplicatePhrases([...all,phrase]).find(group=>group.includes(phrase))!.filter(row=>row!==phrase);
    const existing=sameId??(matches.length===1?matches[0]:undefined);
    const next=existing?mergePhraseGroup([existing,phraseSnapshot(existing,phrase)],existing.id,existing.verified?existing:undefined,phrase.source!=='capture'):phrase;
    const rows=existing?all.map(row=>row.id===existing.id?next:row):[...all,next];
    const result=await consolidatePhrases(tx,rows,previous,new Set([next.id]));
    await done;notify();return result.bySource.get(phrase.id)!;
  }catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
}
function spellingChanged(before:Phrase,after:Phrase):boolean {
  return normalizeRoman(before.roman)!==normalizeRoman(after.roman)||before.reading.normalize('NFKC')!==after.reading.normalize('NFKC');
}
export async function updatePhrase(id:string,patch:Partial<Phrase>):Promise<Phrase> {
  const database=await db(),tx=database.transaction(['phrases','attempts','phraseAliases'],'readwrite'),done=complete(tx),store=tx.objectStore('phrases');
  try{
    const rows=await request<Phrase[]>(store.getAll()),existing=rows.find(row=>row.id===id||row.seenSources?.some(source=>source.id===id));
    if(!existing)throw new Error('語句が見つかりません。');
    const next=validatePhrase({...existing,...patch,id:existing.id});
    const result=await consolidatePhrases(tx,rows.map(row=>row.id===existing.id?next:row),new Map(rows.map(row=>[row.id,row])),new Set([existing.id]));
    await done;notify();return result.bySource.get(existing.id)!;
  }catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
}
export async function deletePhrase(id:string):Promise<void> {
  const database=await db(),tx=database.transaction(['phrases','attempts','phraseAliases'],'readwrite'),done=complete(tx);
  const aliases=tx.objectStore('phraseAliases'),alias=await request<{phraseId:string}|undefined>(aliases.get(id)),canonical=alias?.phraseId??id;
  tx.objectStore('phrases').delete(canonical);
  const attempts=tx.objectStore('attempts'),keys=await request<IDBValidKey[]>(attempts.index('phraseId').getAllKeys(canonical));
  for(const key of keys)attempts.delete(key);
  const aliasKeys=await request<IDBValidKey[]>(aliases.index('phraseId').getAllKeys(canonical));for(const key of aliasKeys)aliases.delete(key);
  await done;notify();
}
export async function saveAttempt(value:Attempt):Promise<void> {
  const attempt=validateAttempt(value),database=await db(),tx=database.transaction(['attempts','phrases','phraseAliases'],'readwrite'),done=complete(tx);
  const alias=await request<{phraseId:string}|undefined>(tx.objectStore('phraseAliases').get(attempt.phraseId));
  const phrase=await request<Phrase|undefined>(tx.objectStore('phrases').get(alias?.phraseId??attempt.phraseId));
  if(!phrase){tx.abort();await done.catch(()=>{});throw new Error('語句を保存してから練習結果を保存してください。');}
  const compatible=attempt.judgements?compatibleAttemptWithPhrase(phrase,attempt):phrase.id===attempt.phraseId;
  const result={...attempt,phraseId:phrase.id,reliable:attempt.reliable&&compatible};
  tx.objectStore('attempts').put(result);await done;notify();
}
export async function saveSession(value:Session):Promise<void> {
  // An explicit edit replaces the previous derived total along with its score.
  // Legacy import/upgrade contradictions are handled separately below.
  let session=validateSession(value.score!==undefined&&value.scoreSource==='manual'?{...value,scoreTotal:value.score}:value);
  const database=await db(),tx=database.transaction('sessions','readwrite'),done=complete(tx),store=tx.objectStore('sessions');
  const existing=await request<Session|undefined>(store.get(session.id));
  if(session.score!==undefined&&session.scoreSource==='manual'){
    session={...session,scoreTotal:session.score,scoreObservedAt:Date.now()};
    delete session.scoreConfidence;delete session.scoreEvidence;delete session.scoreReview;
  }else if(existing?.score!==undefined&&(
    existing.scoreSource!=='ocr'||session.score===undefined||session.scoreSource!=='ocr'||
    (existing.scoreObservedAt??0)>(session.scoreObservedAt??0)
  )){
    // Capture counts are saved asynchronously. A stale session object must not
    // erase an automatic score, or overwrite an explicit/manual correction.
    session=withScoreFrom(session,existing);
  }else if(existing?.scoreReview&&session.score===undefined&&(!session.scoreReview||existing.scoreReview.observedAt>session.scoreReview.observedAt)){
    session.scoreReview=existing.scoreReview;
  }
  const activity=mergeDailyActivity(existing?.activity,session.activity);
  if(activity!==undefined){
    try{session.activity=validateDailyActivity(activity);}catch(error){tx.abort();await done.catch(()=>{});throw error;}
  }
  store.put(session);await done;notify();
}
const scoreFields=['score','scoreType','scoreSource','scoreConfidence','scoreObservedAt','scoreEvidence','scoreModeSource','scoreTotal','scoreReview'] as const;
function withScoreFrom(session:Session,existing:Session):Session {
  const result={...session};
  for(const field of scoreFields){if(existing[field]!==undefined)(result as unknown as Record<string,unknown>)[field]=existing[field];else delete (result as unknown as Record<string,unknown>)[field];}
  return result;
}
export interface AutomaticScore {
  score:number;scoreType:'total';scoreConfidence:number;scoreObservedAt:number;
  scoreEvidence?:string;scoreTotal?:number;scoreModeSource?:'configured'|'ocr';
}
/** Atomically record OCR results without overwriting a manual/legacy score. */
export async function saveAutomaticScore(sessionId:string,patch:AutomaticScore):Promise<boolean> {
  identifier(sessionId);
  const type=scoreType(patch.scoreType),score=number(patch.score,'合計金額',0,10010000);
  const confidence=number(patch.scoreConfidence,'スコア認識率',0,100),at=number(patch.scoreObservedAt,'スコア確認時刻');
  const total=patch.scoreTotal===undefined?score:number(patch.scoreTotal,'合計金額',0,10010000);
  if(total!==score)throw new Error('合計金額が一致しません。');
  const evidence=patch.scoreEvidence===undefined?undefined:imageData(patch.scoreEvidence,'スコア画像');
  const modeSource=patch.scoreModeSource===undefined?undefined:validateScoreModeSource(patch.scoreModeSource);
  const database=await db(),tx=database.transaction('sessions','readwrite'),done=complete(tx),store=tx.objectStore('sessions');
  const existing=await request<Session|undefined>(store.get(sessionId));
  if(!existing){await done;throw new Error('スコアを保存するセッションが見つかりません。');}
  if(existing.score!==undefined&&(existing.scoreSource!=='ocr'||
      (existing.score===score&&existing.scoreType===type)||
      (existing.scoreObservedAt??0)>=at||(existing.scoreConfidence??0)>confidence)){
    await done;return false;
  }
  const next:Session={...existing,score,scoreType:type,scoreSource:'ocr',scoreConfidence:confidence,scoreObservedAt:at,scoreTotal:total};
  if(evidence!==undefined)next.scoreEvidence=evidence;else delete next.scoreEvidence;
  if(modeSource!==undefined)next.scoreModeSource=modeSource;
  delete next.scoreReview;
  store.put(next);await done;notify();return true;
}
export async function updateSettings(patch:Partial<Settings>):Promise<Settings> {
  const database=await db(),tx=database.transaction('settings','readwrite'),done=complete(tx),store=tx.objectStore('settings');
  const existing=await request<Settings|undefined>(store.get('main'));
  let value:Settings;try{value=validateSettings({...DEFAULT_SETTINGS,...existing,...patch});}catch(error){tx.abort();await done.catch(()=>{});throw error;}
  store.put(value,'main');await done;notify();return value;
}
export async function exportData():Promise<AppData&{version:1;exportedAt:number}> {
  const backup={...await getData(),version:1 as const,exportedAt:Date.now()};
  // Use the restore validator before reporting success, including its record
  // and nested-field limits. Keep the original snapshot and every image intact.
  const validated=validateImport(backup);
  const phraseIds=new Set(validated.phrases.map(p=>p.id)),sessionIds=new Set(validated.sessions.map(s=>s.id));
  // A full backup must restore into an empty profile, without relying on records
  // that happen to exist in the destination of an otherwise valid merge import.
  if(validated.attempts.some(a=>!phraseIds.has(a.phraseId)||!sessionIds.has(a.sessionId)))throw new Error('参照する語句・セッションが見つからないため、バックアップを書き出せません。');
  return backup;
}
export async function clearData():Promise<void> {
  const database=await db(),tx=database.transaction([...STORE_NAMES],'readwrite'),done=complete(tx);for(const name of STORE_NAMES)tx.objectStore(name).clear();await done;notify();
}
export async function importData(value:unknown):Promise<void> {
  // Validate every byte-bound field before opening a write transaction: malformed imports make no partial writes.
  const imported=validateImport(value),database=await db(),tx=database.transaction([...STORE_NAMES],'readwrite'),done=complete(tx);
  try{
    const [currentPhrases,currentSessions]=await Promise.all([request<Phrase[]>(tx.objectStore('phrases').getAll()),request<Session[]>(tx.objectStore('sessions').getAll())]);
    const phraseIds=new Set([...currentPhrases,...imported.phrases].flatMap(phrase=>[phrase.id,...phraseSeenSources(phrase).map(source=>source.id)])),sessionIds=new Set([...currentSessions,...imported.sessions].map(s=>s.id));
    if(imported.attempts.some(a=>!phraseIds.has(a.phraseId)||!sessionIds.has(a.sessionId)))throw new Error('参照する語句・セッションが見つからないデータです。');
    const previousPhrases=new Map(currentPhrases.map(phrase=>[phrase.id,phrase])),working=new Map(previousPhrases),sourceOwners=new Map<string,string>();
    for(const phrase of currentPhrases)for(const source of phraseSeenSources(phrase))sourceOwners.set(source.id,phrase.id);
    const changedIds=new Set<string>(),replacedAttemptIds=new Set(imported.attempts.map(attempt=>attempt.id));
    for(const phrase of imported.phrases){
      const previous=working.get(sourceOwners.get(phrase.id)??phrase.id);
      let next=phrase;
      if(previous){
        // Replaying an old merged ID may add evidence, but cannot downgrade a
        // subsequently verified spelling. Explicit canonical-ID edits retain
        // the import's existing replacement semantics.
        const keepVerified=previous.id!==phrase.id&&previous.verified;
        // Legacy backup rows carry counts for their original ID; unlike a
        // savePhrase(canonicalSnapshot), they are not aggregate-count updates.
        // A canonical backup already carries its finite original-image archive,
        // so replaying it must not archive the current live preview again.
        const canonicalSnapshot=phrase.id===previous.id&&phrase.seenSources!==undefined;
        next={...mergePhraseGroup([previous,phrase],previous.id,keepVerified?previous:phrase,!canonicalSnapshot),verified:keepVerified||phrase.verified};
      }
      working.set(next.id,next);changedIds.add(next.id);
      for(const source of phraseSeenSources(next))sourceOwners.set(source.id,next.id);
    }
    const consolidated=await consolidatePhrases(tx,[...working.values()],previousPhrases,changedIds,replacedAttemptIds);
    const importedPhrases=new Map(imported.phrases.map(phrase=>[phrase.id,phrase]));
    for(const attempt of imported.attempts){
      const target=consolidated.bySource.get(attempt.phraseId)!;
      const before=importedPhrases.get(attempt.phraseId)??previousPhrases.get(attempt.phraseId)??currentPhrases.find(phrase=>phrase.seenSources?.some(source=>source.id===attempt.phraseId));
      const reliable=attempt.reliable&&(before?compatiblePhraseAttempt(before,target,attempt):attempt.phraseId===target.id||compatibleAttemptWithPhrase(target,attempt));
      tx.objectStore('attempts').put({...attempt,phraseId:target.id,reliable});
    }
    const previousSessions=new Map(currentSessions.map(session=>[session.id,session]));
    for(const session of imported.sessions){
      const activity=mergeDailyActivity(previousSessions.get(session.id)?.activity,session.activity);
      tx.objectStore('sessions').put(activity===undefined?session:{...session,activity:validateDailyActivity(activity)});
    }
    tx.objectStore('settings').put(imported.settings,'main');await done;notify();
  }catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
}
function object(value:unknown,label:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label}の形式が正しくありません。`);return value as Record<string,unknown>;
}
function text(value:unknown,label:string,max=1000,empty=false):string {
  if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))throw new Error(`${label}を確認してください。`);return value;
}
function number(value:unknown,label:string,min=0,max=Number.MAX_SAFE_INTEGER):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${label}を確認してください。`);return value;
}
function bool(value:unknown,label:string):boolean {if(typeof value!=='boolean')throw new Error(`${label}を確認してください。`);return value;}
function source(value:unknown):Source {if(value==='demo')throw new Error('デモデータは実際の記録に保存できません。');if(!['capture','practice','manual'].includes(String(value)))throw new Error('記録元が不明です。');return value as Source;}
function identifier(value:unknown):string {return text(value,'ID',200);}
function scoreType(value:unknown):'total' {if(value!=='total')throw new Error('食べた金額の合計を指定してください。');return value;}
function legacyScoreType(value:unknown):'profit'|'total' {if(value!=='profit'&&value!=='total')throw new Error('スコアの種類を確認してください。');return value;}
function list(value:unknown,label:string,max:number):unknown[] {if(!Array.isArray(value)||value.length>max)throw new Error(`${label}の件数が多すぎるか、形式が正しくありません。`);return value;}
function imageData(value:unknown,label:string):string {
  const result=text(value,label,3000000);
  if(!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(result))throw new Error('画像の形式が正しくありません。');
  return result;
}
function validatePhrase(value:unknown):Phrase {
  const p=object(value,'語句');
  const result:Phrase={id:identifier(p.id),text:text(p.text,'語句',300),reading:text(p.reading,'よみ',500,true),roman:normalizeRoman(text(p.roman,'ローマ字',1000,true)),source:source(p.source),confidence:number(p.confidence,'認識率',0,100),verified:bool(p.verified,'確認状態'),capturedAt:number(p.capturedAt,'出題時刻'),lastSeenAt:number(p.lastSeenAt,'出題時刻'),seenCount:number(p.seenCount,'出題回数',0,1000000)};
  if(result.roman&&!/^[\x21-\x7e]+$/.test(result.roman))throw new Error('ローマ字は半角英数・記号で入力してください。');
  if(result.verified&&!result.roman)throw new Error('確認済みの語句にはローマ字が必要です。');
  if(p.screenshot!==undefined)result.screenshot=imageData(p.screenshot,'画像');
  if(p.screenshots!==undefined)result.screenshots=list(p.screenshots,'保存画像',1000).map(value=>imageData(value,'画像'));
  if(new Set([...(result.screenshot?[result.screenshot]:[]),...(result.screenshots??[])]).size>1000)throw new Error('保存画像の件数が多すぎます。');
  if(p.seenSources!==undefined){
    result.seenSources=list(p.seenSources,'出題元',100000).map(value=>{const entry=object(value,'出題元');return {id:identifier(entry.id),count:number(entry.count,'出題回数',0,1000000)};});
    if(new Set(result.seenSources.map(source=>source.id)).size!==result.seenSources.length||!result.seenSources.some(source=>source.id===result.id)||result.seenSources.reduce((sum,source)=>sum+source.count,0)!==result.seenCount)throw new Error('出題元と出題回数が一致しません。');
  }
  if(p.tags!==undefined)result.tags=list(p.tags,'タグ',20).map(x=>text(x,'タグ',60));
  return result;
}
function validateSample(value:unknown):StrokeSample {
  const s=object(value,'入力間隔');return {pattern:text(s.pattern,'組み合わせ',3),intervalMs:number(s.intervalMs,'入力間隔',0,60000),error:bool(s.error,'入力結果'),at:number(s.at,'打鍵時刻')};
}
function validateAttempt(value:unknown):Attempt {
  const a=object(value,'練習結果');const result:Attempt={id:identifier(a.id),phraseId:identifier(a.phraseId),sessionId:identifier(a.sessionId),source:source(a.source),startedAt:number(a.startedAt,'開始時刻'),endedAt:number(a.endedAt,'終了時刻'),durationMs:number(a.durationMs,'練習時間',0,86400000),correctKeys:number(a.correctKeys,'正しい入力数',0,10000),mistakes:number(a.mistakes,'ミス数',0,10000),accuracy:number(a.accuracy,'正確率',0,100),kps:number(a.kps,'入力速度',0,1000),samples:list(a.samples,'入力間隔',2000).map(validateSample),complete:bool(a.complete,'完了状態'),reliable:bool(a.reliable,'測定状態'),typed:text(a.typed,'入力内容',10000,true)};
  if(result.endedAt<result.startedAt)throw new Error('終了時刻が開始時刻より前です。');
  if(a.judgements!==undefined){
    result.judgements=list(a.judgements,'打鍵の詳細',20000).map(validateJudgement);
    let position=0,at=result.startedAt;
    for(const key of result.judgements){
      if(key.at<result.startedAt||key.at>result.endedAt||key.position!==position||(result.reliable&&key.at<at))throw new Error('打鍵の順序・時刻を確認してください。');
      const normalized=normalizeRoman(key.actual);
      if(key.accepted!==key.expected.includes(normalized))throw new Error('打鍵の正誤と正解キーが一致しません。');
      if(key.accepted)position++;at=key.at;
    }
    if(position!==result.correctKeys||result.judgements.length-position!==result.mistakes)throw new Error('打鍵の詳細と入力数が一致しません。');
  }
  if(a.errorTerminated!==undefined){
    result.errorTerminated=bool(a.errorTerminated,'ミスによる終了状態');
    if(result.errorTerminated&&!isErrorTerminatedAttempt(result))throw new Error('ミスによる終了と打鍵の詳細が一致しません。');
  }
  return result;
}
function validateJudgement(value:unknown):KeyJudgement {
  const k=object(value,'打鍵の詳細'),actual=text(k.actual,'実際のキー',1,true),expected=list(k.expected,'正解キー',94).map(x=>text(x,'正解キー',1));
  if(!/^[\x20-\x7e]$/.test(actual)||!expected.length||expected.some(key=>!/^[\x21-\x7e]$/.test(key))||new Set(expected).size!==expected.length)throw new Error('打鍵キーの形式が正しくありません。');
  const position=number(k.position,'打鍵位置',0,10000);if(!Number.isInteger(position))throw new Error('打鍵位置を確認してください。');
  const result:KeyJudgement={actual,expected,accepted:bool(k.accepted,'入力結果'),position,at:number(k.at,'打鍵時刻')};
  if(k.intervalMs!==undefined)result.intervalMs=number(k.intervalMs,'入力間隔',15,2000);
  if(k.pattern!==undefined){result.pattern=text(k.pattern,'組み合わせ',3);if(!/^[\x21-\x7e]{1,3}$/.test(result.pattern))throw new Error('組み合わせを確認してください。');}
  return result;
}
function validateScoreReview(value:unknown):ScoreReview {
  const r=object(value,'スコアの確認'),type=scoreType(r.scoreType);
  const result:ScoreReview={scoreType:type,confidence:number(r.confidence,'スコア認識率',0,100),observedAt:number(r.observedAt,'スコア確認時刻'),reason:text(r.reason,'確認理由',2000)};
  if(r.score!==undefined)result.score=number(r.score,'合計金額の候補',0,10010000);
  if(r.evidence!==undefined)result.evidence=imageData(r.evidence,'スコア画像');
  return result;
}
function validateScoreModeSource(value:unknown):'configured'|'ocr' {
  if(value!=='configured'&&value!=='ocr')throw new Error('モードの確認元を確認してください。');return value;
}
function validateDailyActivity(value:unknown):DailyActivity[] {
  const rows=list(value,'日別の練習記録',MAX_ACTIVITY_DAYS).map(value=>{
    const row=object(value,'日別の練習記録');
    if(!validTrainingDate(row.date))throw new Error('練習日を確認してください。');
    const activeMs=number(row.activeMs,'入力時間',0,MAX_ACTIVITY_MS),keys=number(row.keys,'打鍵数',0,MAX_ACTIVITY_KEYS),phrases=number(row.phrases,'出題数',0,MAX_ACTIVITY_PHRASES);
    if(!Number.isInteger(keys)||!Number.isInteger(phrases))throw new Error('打鍵数・出題数は整数で指定してください。');
    return {date:row.date,activeMs,keys,phrases};
  });
  if(new Set(rows.map(row=>row.date)).size!==rows.length)throw new Error('練習日が重複しています。');
  if(rows.reduce((sum,row)=>sum+row.activeMs,0)>MAX_ACTIVITY_MS||rows.reduce((sum,row)=>sum+row.keys,0)>MAX_ACTIVITY_KEYS||rows.reduce((sum,row)=>sum+row.phrases,0)>MAX_ACTIVITY_PHRASES)throw new Error('日別の練習記録の合計が上限を超えています。');
  return rows.sort((a,b)=>a.date.localeCompare(b.date));
}
function validateSession(value:unknown):Session {
  const s=object(value,'セッション');if(s.course!==10000||s.mode!=='accuracy')throw new Error('10,000円・正確重視の記録のみ読み込めます。');
  const result:Session={id:identifier(s.id),startedAt:number(s.startedAt,'開始時刻'),source:source(s.source),scoreType:scoreType(s.scoreType),course:10000,mode:'accuracy',phraseCount:number(s.phraseCount,'語句数',0,1000000),correctKeys:number(s.correctKeys,'正しい入力数',0,10000000),mistakes:number(s.mistakes,'ミス数',0,10000000),durationMs:number(s.durationMs,'セッション時間',0,86400000)};
  if(s.endedAt!==undefined)result.endedAt=number(s.endedAt,'終了時刻',result.startedAt);
  if(s.score!==undefined)result.score=number(s.score,'合計金額',0,10010000);
  if(s.captureId!==undefined)result.captureId=identifier(s.captureId);
  if(s.scoreSource!==undefined){if(s.scoreSource!=='ocr'&&s.scoreSource!=='manual')throw new Error('スコアの記録元を確認してください。');result.scoreSource=s.scoreSource;}
  if(s.scoreConfidence!==undefined)result.scoreConfidence=number(s.scoreConfidence,'スコア認識率',0,100);
  if(s.scoreObservedAt!==undefined)result.scoreObservedAt=number(s.scoreObservedAt,'スコア確認時刻');
  if(s.scoreEvidence!==undefined)result.scoreEvidence=imageData(s.scoreEvidence,'スコア画像');
  if(s.scoreModeSource!==undefined)result.scoreModeSource=validateScoreModeSource(s.scoreModeSource);
  if(s.scoreTotal!==undefined)result.scoreTotal=number(s.scoreTotal,'合計金額',0,10010000);
  if(result.score!==undefined&&result.scoreTotal!==undefined&&result.score!==result.scoreTotal)throw new Error('合計金額が一致しません。');
  if(s.scoreReview!==undefined)result.scoreReview=validateScoreReview(s.scoreReview);
  if(s.activity!==undefined)result.activity=validateDailyActivity(s.activity);
  return result;
}
/** Convert legacy money fields once at the upgrade/import boundary only. */
function migrateSessionToTotal(value:unknown):Session {
  const old=object(value,'セッション'),type=legacyScoreType(old.scoreType);
  if(old.course!==10000)throw new Error('10,000円コースの記録のみ読み込めます。');
  const next:Record<string,unknown>={...old,scoreType:'total'};
  const candidates:number[]=[];
  if(old.score!==undefined){
    const amount=number(old.score,'保存済みの金額',type==='profit'?-10000:0,type==='profit'?10000000:10010000)+(type==='profit'?10000:0);
    next.score=amount;candidates.push(amount);
  }
  if(old.scoreTotal!==undefined)candidates.push(number(old.scoreTotal,'保存済みの合計金額',0,10010000));
  if(old.scoreProfit!==undefined){
    const total=number(old.scoreProfit,'保存済みの差額',-10000,10000000)+10000;
    candidates.push(total);
    if(next.scoreTotal===undefined)next.scoreTotal=total;
  }
  delete next.scoreProfit;
  let priorReview:ScoreReview|undefined;
  if(old.scoreReview!==undefined){
    const review=object(old.scoreReview,'スコアの確認'),reviewType=legacyScoreType(review.scoreType);
    priorReview=validateScoreReview({...review,scoreType:'total',...(review.score===undefined?{}:{
      score:number(review.score,'保存済みの候補',reviewType==='profit'?-10000:0,reviewType==='profit'?10000000:10010000)+(reviewType==='profit'?10000:0),
    })});
    next.scoreReview=priorReview;
  }
  const unique=[...new Set(candidates)];
  if(unique.length>1){
    // Preserve every candidate and the existing review evidence, but never pick
    // one inconsistent value for charts or prefill a supposedly confirmed score.
    const amounts=unique.map(amount=>`${amount}円`).join(' / ');
    const previous=priorReview?` 以前の確認${priorReview.score===undefined?'':`（候補 ${priorReview.score}円）`}: ${priorReview.reason}`:'';
    const evidence=priorReview?.evidence??old.scoreEvidence;
    const review:Record<string,unknown>={scoreType:'total',
      confidence:priorReview?.confidence??old.scoreConfidence??0,
      observedAt:priorReview?.observedAt??old.scoreObservedAt??old.endedAt??old.startedAt,
      reason:`合計金額の候補が一致しません（${amounts}）。結果画像を確認してください。${previous}`,
      ...(evidence===undefined?{}:{evidence}),
    };
    next.scoreReview=validateScoreReview(review);
    delete next.score;delete next.scoreTotal;
  }
  return validateSession(next);
}
function migrateSettingsToTotal(value:unknown):Settings {
  const old=object(value,'設定');legacyScoreType(old.scoreType);
  // Goals and the baseline are user choices, not historical score observations.
  return validateSettings({...old,scoreType:'total'});
}
function validateRect(value:unknown):Rect {
  const r=object(value,'読取範囲');const result={x:number(r.x,'範囲 X',0,1),y:number(r.y,'範囲 Y',0,1),width:number(r.width,'幅',0.005,1),height:number(r.height,'高さ',0.005,1)};
  if(result.x+result.width>1.001||result.y+result.height>1.001)throw new Error('読取範囲が画面の外にあります。');return result;
}
function validateSettings(value:unknown):Settings {
  const s=object(value,'設定');const targetDate=text(s.targetDate,'目標日',10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)||!Number.isFinite(Date.parse(targetDate))||new Date(`${targetDate}T00:00:00Z`).toISOString().slice(0,10)!==targetDate)throw new Error('目標日を確認してください。');
  const result:Settings={targetScore:number(s.targetScore,'目標スコア',1,10000000),baselineScore:number(s.baselineScore,'開始時のスコア',-10000,10000000),targetDate,scoreType:scoreType(s.scoreType),sessionLength:Math.round(number(s.sessionLength,'復習語句数',1,100)),includeUnverified:bool(s.includeUnverified,'未確認語句の設定'),autoRecord:s.autoRecord===undefined?true:bool(s.autoRecord,'自動記録の設定')};
  if(s.calibration!==undefined){const c=object(s.calibration,'読取範囲');const calibration:Calibration={japanese:validateRect(c.japanese),roman:validateRect(c.roman),updatedAt:number(c.updatedAt,'設定時刻')};if(c.reading!==undefined)calibration.reading=validateRect(c.reading);if(c.viewport!==undefined){const v=object(c.viewport,'画面サイズ');calibration.viewport={width:number(v.width,'画面の幅',1,20000),height:number(v.height,'画面の高さ',1,20000)};}result.calibration=calibration;}
  return result;
}
export function validateImport(value:unknown):AppData {
  const data=object(value,'バックアップ');if(data.version!==1)throw new Error('UCHIKOMI v1のバックアップを選択してください。');
  const phrases=list(data.phrases,'語句',20000).map(validatePhrase),attempts=list(data.attempts,'練習結果',100000).map(validateAttempt),sessions=list(data.sessions,'セッション',20000).map(migrateSessionToTotal);
  for(const values of [phrases,attempts,sessions])if(new Set(values.map(x=>x.id)).size!==values.length)throw new Error('IDが重複したバックアップです。');
  return {phrases,attempts,sessions,settings:migrateSettingsToTotal(data.settings)};
}
