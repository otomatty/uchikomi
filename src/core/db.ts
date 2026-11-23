import { DEFAULT_SETTINGS } from './types';
import type { AppData, Attempt, Calibration, KeyJudgement, Phrase, Rect, ScoreReview, Session, Settings, Source, StrokeSample } from './types';
import { normalizeRoman } from './romaji';
import { isErrorTerminatedAttempt } from './analytics';
const DB_NAME='uchikomi-v1', VERSION=1;
const STORE_NAMES=['phrases','attempts','sessions','settings'] as const;
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
    request.onupgradeneeded=()=>{
      const result=request.result;
      result.createObjectStore('phrases',{keyPath:'id'});
      const attempts=result.createObjectStore('attempts',{keyPath:'id'});attempts.createIndex('phraseId','phraseId');attempts.createIndex('sessionId','sessionId');
      result.createObjectStore('sessions',{keyPath:'id'});result.createObjectStore('settings');
    };
    request.onerror=()=>{database=undefined;reject(request.error??new Error('データを開けませんでした。'));};
    request.onblocked=()=>{database=undefined;reject(new Error('別のUCHIKOMI画面を閉じて再度お試しください。'));};
    request.onsuccess=()=>{const result=request.result;result.onversionchange=()=>{result.close();database=undefined;};resolve(result);};
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
function samePhrase(a:Phrase,b:Phrase):boolean {
  const text=(s:string)=>s.normalize('NFKC').replace(/\s+/g,'');
  return text(a.text)===text(b.text)&&((a.reading&&b.reading&&text(a.reading)===text(b.reading))||normalizeRoman(a.roman)===normalizeRoman(b.roman));
}
export async function savePhrase(value:Phrase):Promise<Phrase> {
  const phrase=validatePhrase(value),database=await db(),tx=database.transaction(['phrases','attempts'],'readwrite'),done=complete(tx),store=tx.objectStore('phrases');
  const all=await request<Phrase[]>(store.getAll()),existing=all.find(p=>p.id===phrase.id)??all.find(p=>samePhrase(p,phrase));
  const result:Phrase=existing?{...phrase,...(existing.verified?existing:{}),id:existing.id,verified:existing.verified||phrase.verified,
    capturedAt:Math.min(existing.capturedAt,phrase.capturedAt),lastSeenAt:Math.max(existing.lastSeenAt,phrase.lastSeenAt),
    confidence:Math.max(existing.confidence,phrase.confidence),seenCount:existing.id===phrase.id?Math.max(existing.seenCount,phrase.seenCount):existing.seenCount+Math.max(1,phrase.seenCount),
    screenshot:phrase.screenshot??existing.screenshot,tags:[...new Set([...(existing.tags??[]),...(phrase.tags??[])])]}:phrase;
  store.put(result);
  if(existing&&spellingChanged(existing,result))await invalidatePhraseAttempts(tx.objectStore('attempts'),existing.id);
  await done;notify();return result;
}
function spellingChanged(before:Phrase,after:Phrase):boolean {
  return normalizeRoman(before.roman)!==normalizeRoman(after.roman)||before.reading.normalize('NFKC')!==after.reading.normalize('NFKC');
}
async function invalidatePhraseAttempts(store:IDBObjectStore,phraseId:string):Promise<void> {
  const attempts=await request<Attempt[]>(store.index('phraseId').getAll(phraseId));
  // Preserve history but do not attribute old measurements to the newly corrected reading.
  for(const attempt of attempts)if(attempt.reliable)store.put({...attempt,reliable:false});
}
export async function updatePhrase(id:string,patch:Partial<Phrase>):Promise<void> {
  const database=await db(),tx=database.transaction(['phrases','attempts'],'readwrite'),done=complete(tx),store=tx.objectStore('phrases');
  const existing=await request<Phrase|undefined>(store.get(id));
  if(!existing){await done;throw new Error('語句が見つかりません。');}
  let next:Phrase;try{next=validatePhrase({...existing,...patch,id:existing.id});}catch(error){tx.abort();await done.catch(()=>{});throw error;}
  store.put(next);
  if(spellingChanged(existing,next))await invalidatePhraseAttempts(tx.objectStore('attempts'),existing.id);
  await done;notify();
}
export async function deletePhrase(id:string):Promise<void> {
  const database=await db(),tx=database.transaction(['phrases','attempts'],'readwrite'),done=complete(tx);
  tx.objectStore('phrases').delete(id);
  const attempts=tx.objectStore('attempts'),keys=await request<IDBValidKey[]>(attempts.index('phraseId').getAllKeys(id));
  for(const key of keys)attempts.delete(key);await done;notify();
}
export async function saveAttempt(value:Attempt):Promise<void> {
  const attempt=validateAttempt(value),database=await db(),tx=database.transaction(['attempts','phrases'],'readwrite'),done=complete(tx);
  const phrase=await request(tx.objectStore('phrases').get(attempt.phraseId));
  if(!phrase){tx.abort();await done.catch(()=>{});throw new Error('語句を保存してから練習結果を保存してください。');}
  tx.objectStore('attempts').put(attempt);await done;notify();
}
export async function saveSession(value:Session):Promise<void> {
  let session=validateSession(value);
  const database=await db(),tx=database.transaction('sessions','readwrite'),done=complete(tx),store=tx.objectStore('sessions');
  const existing=await request<Session|undefined>(store.get(session.id));
  if(session.score!==undefined&&session.scoreSource==='manual'){
    session={...session,scoreTotal:session.scoreType==='total'?session.score:session.score+10000,
      scoreProfit:session.scoreType==='profit'?session.score:session.score-10000,scoreObservedAt:Date.now()};
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
  store.put(session);await done;notify();
}
const scoreFields=['score','scoreType','scoreSource','scoreConfidence','scoreObservedAt','scoreEvidence','scoreModeSource','scoreTotal','scoreProfit','scoreReview'] as const;
function withScoreFrom(session:Session,existing:Session):Session {
  const result={...session};
  for(const field of scoreFields){if(existing[field]!==undefined)(result as unknown as Record<string,unknown>)[field]=existing[field];else delete (result as unknown as Record<string,unknown>)[field];}
  return result;
}
export interface AutomaticScore {
  score:number;scoreType:'profit'|'total';scoreConfidence:number;scoreObservedAt:number;
  scoreEvidence?:string;scoreTotal?:number;scoreProfit?:number;scoreModeSource?:'configured'|'ocr';
}
/** Atomically record OCR results without overwriting a manual/legacy score. */
export async function saveAutomaticScore(sessionId:string,patch:AutomaticScore):Promise<boolean> {
  identifier(sessionId);
  const type=scoreType(patch.scoreType),score=number(patch.score,'スコア',type==='profit'?-10000:0,10000000);
  const confidence=number(patch.scoreConfidence,'スコア認識率',0,100),at=number(patch.scoreObservedAt,'スコア確認時刻');
  const total=patch.scoreTotal===undefined?(type==='total'?score:score+10000):number(patch.scoreTotal,'合計金額',0,10010000);
  const profit=patch.scoreProfit===undefined?(type==='profit'?score:score-10000):number(patch.scoreProfit,'お得金額',-10000,10000000);
  if(total-profit!==10000||(type==='total'?total:profit)!==score)throw new Error('合計金額とお得金額が一致しません。');
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
  const next:Session={...existing,score,scoreType:type,scoreSource:'ocr',scoreConfidence:confidence,scoreObservedAt:at,scoreTotal:total,scoreProfit:profit};
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
  const [currentPhrases,currentSessions]=await Promise.all([request<Phrase[]>(tx.objectStore('phrases').getAll()),request<Session[]>(tx.objectStore('sessions').getAll())]);
  const phraseIds=new Set([...currentPhrases,...imported.phrases].map(p=>p.id)),sessionIds=new Set([...currentSessions,...imported.sessions].map(s=>s.id));
  if(imported.attempts.some(a=>!phraseIds.has(a.phraseId)||!sessionIds.has(a.sessionId))){tx.abort();await done.catch(()=>{});throw new Error('参照する語句・セッションが見つからないデータです。');}
  for(const phrase of imported.phrases)tx.objectStore('phrases').put(phrase);
  for(const attempt of imported.attempts)tx.objectStore('attempts').put(attempt);
  for(const session of imported.sessions)tx.objectStore('sessions').put(session);
  tx.objectStore('settings').put(imported.settings,'main');await done;notify();
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
function scoreType(value:unknown):'profit'|'total' {if(value!=='profit'&&value!=='total')throw new Error('スコアの種類を確認してください。');return value;}
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
  const result:ScoreReview={scoreType:type,confidence:number(r.confidence,'スコア認識率',0,100),observedAt:number(r.observedAt,'スコア確認時刻'),reason:text(r.reason,'確認理由',500)};
  if(r.score!==undefined)result.score=number(r.score,'スコア候補',type==='profit'?-10000:0,10000000);
  if(r.evidence!==undefined)result.evidence=imageData(r.evidence,'スコア画像');
  return result;
}
function validateScoreModeSource(value:unknown):'configured'|'ocr' {
  if(value!=='configured'&&value!=='ocr')throw new Error('モードの確認元を確認してください。');return value;
}
function validateSession(value:unknown):Session {
  const s=object(value,'セッション');if(s.course!==10000||s.mode!=='accuracy')throw new Error('10,000円・正確重視の記録のみ読み込めます。');
  const result:Session={id:identifier(s.id),startedAt:number(s.startedAt,'開始時刻'),source:source(s.source),scoreType:scoreType(s.scoreType),course:10000,mode:'accuracy',phraseCount:number(s.phraseCount,'語句数',0,1000000),correctKeys:number(s.correctKeys,'正しい入力数',0,10000000),mistakes:number(s.mistakes,'ミス数',0,10000000),durationMs:number(s.durationMs,'セッション時間',0,86400000)};
  if(s.endedAt!==undefined)result.endedAt=number(s.endedAt,'終了時刻',result.startedAt);
  if(s.score!==undefined)result.score=number(s.score,'スコア',result.scoreType==='profit'?-10000:0,10000000);
  if(s.captureId!==undefined)result.captureId=identifier(s.captureId);
  if(s.scoreSource!==undefined){if(s.scoreSource!=='ocr'&&s.scoreSource!=='manual')throw new Error('スコアの記録元を確認してください。');result.scoreSource=s.scoreSource;}
  if(s.scoreConfidence!==undefined)result.scoreConfidence=number(s.scoreConfidence,'スコア認識率',0,100);
  if(s.scoreObservedAt!==undefined)result.scoreObservedAt=number(s.scoreObservedAt,'スコア確認時刻');
  if(s.scoreEvidence!==undefined)result.scoreEvidence=imageData(s.scoreEvidence,'スコア画像');
  if(s.scoreModeSource!==undefined)result.scoreModeSource=validateScoreModeSource(s.scoreModeSource);
  if(s.scoreTotal!==undefined)result.scoreTotal=number(s.scoreTotal,'合計金額',0,10010000);
  if(s.scoreProfit!==undefined)result.scoreProfit=number(s.scoreProfit,'お得金額',-10000,10000000);
  if(s.scoreReview!==undefined)result.scoreReview=validateScoreReview(s.scoreReview);
  return result;
}
function validateRect(value:unknown):Rect {
  const r=object(value,'読取範囲');const result={x:number(r.x,'範囲 X',0,1),y:number(r.y,'範囲 Y',0,1),width:number(r.width,'幅',0.005,1),height:number(r.height,'高さ',0.005,1)};
  if(result.x+result.width>1.001||result.y+result.height>1.001)throw new Error('読取範囲が画面の外にあります。');return result;
}
function validateSettings(value:unknown):Settings {
  const s=object(value,'設定');const targetDate=text(s.targetDate,'目標日',10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)||!Number.isFinite(Date.parse(targetDate))||new Date(`${targetDate}T00:00:00Z`).toISOString().slice(0,10)!==targetDate)throw new Error('目標日を確認してください。');
  const result:Settings={targetScore:number(s.targetScore,'目標スコア',1,10000000),baselineScore:number(s.baselineScore,'開始時のスコア',-10000,10000000),targetDate,scoreType:scoreType(s.scoreType),sessionLength:Math.round(number(s.sessionLength,'復習語句数',1,100)),includeUnverified:bool(s.includeUnverified,'未確認語句の設定')};
  if(s.calibration!==undefined){const c=object(s.calibration,'読取範囲');const calibration:Calibration={japanese:validateRect(c.japanese),roman:validateRect(c.roman),updatedAt:number(c.updatedAt,'設定時刻')};if(c.reading!==undefined)calibration.reading=validateRect(c.reading);if(c.viewport!==undefined){const v=object(c.viewport,'画面サイズ');calibration.viewport={width:number(v.width,'画面の幅',1,20000),height:number(v.height,'画面の高さ',1,20000)};}result.calibration=calibration;}
  return result;
}
export function validateImport(value:unknown):AppData {
  const data=object(value,'バックアップ');if(data.version!==1)throw new Error('UCHIKOMI v1のバックアップを選択してください。');
  const phrases=list(data.phrases,'語句',20000).map(validatePhrase),attempts=list(data.attempts,'練習結果',100000).map(validateAttempt),sessions=list(data.sessions,'セッション',20000).map(validateSession);
  for(const values of [phrases,attempts,sessions])if(new Set(values.map(x=>x.id)).size!==values.length)throw new Error('IDが重複したバックアップです。');
  return {phrases,attempts,sessions,settings:validateSettings(data.settings)};
}
