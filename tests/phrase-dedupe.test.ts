import 'fake-indexeddb/auto';
import { Parser } from 'budoux';
import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deletePhrase, exportData, getData, importData, saveAttempt, savePhrase, saveSession, updatePhrase } from '../src/core/db';
import { clauseTarget } from '../src/core/clauses';
import { analyzeWords, buildAttempt } from '../src/core/analytics';
import { DEFAULT_SETTINGS } from '../src/core/types';
import type { Attempt, Phrase, Session } from '../src/core/types';

const channel=globalThis.BroadcastChannel;(globalThis as any).BroadcastChannel=undefined;
after(()=>{globalThis.BroadcastChannel=channel;});
const name='uchikomi-v1',now=1760000000000;
const requested=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const completed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);});
const remove=()=>requested(indexedDB.deleteDatabase(name));
beforeEach(remove);afterEach(remove);
const phrase=(id:string,patch:Partial<Phrase>={}):Phrase=>({id,text:'写真',reading:'しゃしん',roman:'syasinn',source:'capture',confidence:85,verified:false,capturedAt:now,lastSeenAt:now,seenCount:1,...patch});
const session=(id='game'):Session=>({id,startedAt:now,endedAt:now+5000,source:'capture',scoreType:'total',course:10000,mode:'accuracy',phraseCount:9,correctKeys:70,mistakes:2,durationMs:5000,score:30000,scoreTotal:30000});
const attempt=(p:Phrase,id:string,typed=p.roman):Attempt=>({...buildAttempt({phrase:p,strokes:[...typed].map((key,index)=>({key,at:now+(index+1)*100})),startedAt:now,endedAt:now+2000,sessionId:'game',source:'capture',complete:true,reliable:true}),id});
const images=['data:image/png;base64,AA==','data:image/png;base64,AQ==','data:image/jpeg;base64,Ag=='];

async function legacy(phrases:Phrase[],attempts:Attempt[],sessions:Session[]=[session()]) {
  const opening=indexedDB.open(name,2);
  opening.onupgradeneeded=()=>{
    const db=opening.result;db.createObjectStore('phrases',{keyPath:'id'});
    const store=db.createObjectStore('attempts',{keyPath:'id'});store.createIndex('phraseId','phraseId');store.createIndex('sessionId','sessionId');
    db.createObjectStore('sessions',{keyPath:'id'});db.createObjectStore('settings');
  };
  const db=await requested(opening),tx=db.transaction(['phrases','attempts','sessions','settings'],'readwrite'),done=completed(tx);
  for(const p of phrases)tx.objectStore('phrases').put(p);
  for(const a of attempts)tx.objectStore('attempts').put(a);
  for(const s of sessions)tx.objectStore('sessions').put(s);
  tx.objectStore('settings').put({...DEFAULT_SETTINGS,autoRecord:false},'main');
  await done;db.close();
}

test('v2 duplicates migrate atomically to one phrase with every image, judgement, count and session intact',async()=>{
  const a=phrase('old',{seenCount:3,screenshot:images[0],tags:['first']}),b=phrase('confirmed',{text:'写 真',reading:'シャシン',roman:'shasinn',seenCount:4,verified:true,confidence:98,capturedAt:now+100,lastSeenAt:now+1000,screenshot:images[1],tags:['checked']}),c=phrase('recent',{seenCount:2,capturedAt:now+200,lastSeenAt:now+2000,screenshot:images[2],tags:['first','latest']});
  const histories=[attempt(a,'a'),attempt(b,'b','shasinn'),attempt(c,'c')];
  await legacy([a,b,c],histories);
  const data=await getData();
  assert.equal(data.phrases.length,1);
  const merged=data.phrases[0];
  assert.equal(merged.id,'old');assert.equal(merged.text,b.text);assert.equal(merged.reading,b.reading);
  assert.equal(merged.verified,true);assert.equal(merged.confidence,98);assert.equal(merged.seenCount,9);
  assert.equal(merged.capturedAt,now);assert.equal(merged.lastSeenAt,now+2000);
  assert.deepEqual(new Set([merged.screenshot,...merged.screenshots??[]]),new Set(images));
  assert.deepEqual(new Set(merged.tags),new Set(['first','checked','latest']));
  assert.deepEqual(merged.seenSources,[{id:'confirmed',count:4},{id:'old',count:3},{id:'recent',count:2}]);
  assert.deepEqual(data.attempts,histories.map(value=>({...value,phraseId:'old'})));
  assert.deepEqual(data.sessions,[session()]);assert.equal(data.settings.autoRecord,false);
  const db=await requested(indexedDB.open(name));assert.equal(db.version,3);db.close();
  const reload=await import('../src/core/db.ts?phrase-dedupe-reload');
  assert.deepEqual(await reload.getData(),data);
  const backup=await exportData();await importData(backup);
  assert.deepEqual(await getData(),data,'replaying the consolidated backup is idempotent');
  await importData({version:1,phrases:[a,b,c],attempts:histories,sessions:[session()],settings:{...DEFAULT_SETTINGS,autoRecord:false}});
  assert.deepEqual(await getData(),data,'replaying all original IDs cannot add their counts again');
  await savePhrase(b);await savePhrase({...merged,seenSources:undefined});
  assert.equal((await getData()).phrases[0].seenCount,9,'both retired and canonical IDs are idempotent');
});

test('fresh real captures return the earlier canonical ID and their attempts aggregate together',async()=>{
  const first=await savePhrase(phrase('first',{verified:true}));
  await saveSession(session());await saveAttempt(attempt(first,'one'));
  const later=await savePhrase(phrase('new-observation',{capturedAt:now+3000,lastSeenAt:now+3000,roman:'shasinn'}));
  assert.equal(later.id,first.id);assert.equal(later.seenCount,2);
  await saveAttempt(attempt(later,'two','shasinn'));
  const data=await getData();assert.equal(data.phrases.length,1);assert.equal(data.attempts.length,2);
  assert.ok(data.attempts.every(value=>value.phraseId===first.id&&value.reliable));
  const stats=analyzeWords(data.attempts,data.phrases);assert.equal(stats.length,1);assert.equal(stats[0].attempts,2);
  await Promise.all([savePhrase(phrase('new-observation')),savePhrase(phrase('new-observation'))]);
  assert.equal((await getData()).phrases[0].seenCount,2);
});

test('different readings, homophones, similar text and missing-reading bridges remain separate',async()=>{
  const rows=[
    phrase('science',{text:'生物',reading:'せいぶつ',roman:'seibutu'}),
    phrase('raw',{text:'生物',reading:'なまもの',roman:'seibutu'}),
    phrase('uncertain',{text:'生物',reading:'',roman:'seibutu'}),
    phrase('bridge',{text:'橋',reading:'はし',roman:'hasi'}),
    phrase('chopsticks',{text:'箸',reading:'はし',roman:'hasi'}),
    phrase('near',{text:'写真集',reading:'しゃしん',roman:'syasinn'}),
  ];
  await importData({version:1,phrases:rows,attempts:[],sessions:[],settings:DEFAULT_SETTINGS});
  assert.equal((await getData()).phrases.length,6);
  const same=await savePhrase(phrase('kana-variant',{text:'生 物',reading:'ｾｲﾌﾞﾂ',roman:'seibutsu'}));
  assert.equal(same.id,'science');assert.equal(same.seenCount,2);
  const unknown=await savePhrase(phrase('uncertain-again',{text:'生物',reading:'',roman:'seibutu'}));
  assert.equal(unknown.id,'uncertain');
  assert.equal((await getData()).phrases.length,6);
});

test('correcting a phrase into an existing keyword merges references and invalidates only incompatible measurements',async()=>{
  const wrong=await savePhrase(phrase('wrong',{text:'ペアルク',reading:'ぺあるく',roman:'pearuku'}));
  const correct=await savePhrase(phrase('correct',{text:'ペアルック',reading:'ぺあるっく',roman:'pearukku',capturedAt:now+100,verified:true}));
  await saveSession(session());const old=attempt(wrong,'wrong-attempt'),valid=attempt(correct,'valid-attempt');await saveAttempt(old);await saveAttempt(valid);
  const saved=await updatePhrase(wrong.id,{text:correct.text,reading:correct.reading,roman:correct.roman,verified:true});
  const data=await getData();assert.equal(data.phrases.length,1);assert.equal(data.phrases[0].seenCount,2);
  assert.equal(saved.id,data.phrases[0].id,'editing returns the canonical ID for immediate practice');
  assert.equal(data.attempts.find(value=>value.id===old.id)?.reliable,false);
  assert.equal(data.attempts.find(value=>value.id===valid.id)?.reliable,true);
  assert.ok(data.attempts.every(value=>value.phraseId===data.phrases[0].id));
  assert.deepEqual(data.sessions,[session()]);
  await deletePhrase(correct.id);
  const removed=await getData();assert.equal(removed.phrases.length,0);assert.equal(removed.attempts.length,0);assert.equal(removed.sessions.length,1);
  const fresh=await savePhrase(correct);assert.equal(fresh.id,correct.id);assert.equal(fresh.seenCount,1,'deleted aliases do not revive old counts');
});

test('unknown-reading history is retained but not reinterpreted as reliable after merging into a different input graph',async()=>{
  const unknown=phrase('unknown',{reading:'',roman:'shasinn',seenCount:2}),known=phrase('known',{roman:'shasinn',verified:true,capturedAt:now+100});
  const recorded=attempt(unknown,'unknown-attempt');
  await legacy([unknown,known],[recorded]);
  const data=await getData();assert.equal(data.phrases.length,1);assert.equal(data.phrases[0].seenCount,3);
  assert.deepEqual(data.attempts,[{...recorded,phraseId:'unknown',reliable:false}]);
});

test('invalid provenance or retained-image imports roll back without dropping existing data',async()=>{
  await savePhrase(phrase('kept'));const before=await getData();
  const backup={version:1,phrases:[phrase('new')],attempts:[],sessions:[],settings:DEFAULT_SETTINGS};
  await assert.rejects(importData({...backup,phrases:[phrase('new',{seenSources:[{id:'new',count:2}]})]}),/出題元/);
  await assert.rejects(importData({...backup,phrases:[phrase('new',{screenshots:['https://example.com/image.png']})]}),/画像/);
  await assert.rejects(importData({...backup,phrases:[phrase('new',{screenshots:Array(1001).fill(images[0])})]}),/保存画像/);
  await assert.rejects(importData({...backup,phrases:[phrase('new',{seenSources:[{id:'new',count:1},{id:'shared',count:0}]}),phrase('different',{text:'違う語句',seenSources:[{id:'different',count:1},{id:'shared',count:0}]})]}),/同じ元ID/);
  assert.deepEqual(await getData(),before);
});

test('ordinary repeat captures update one preview while keeping the finite migration image archive',async()=>{
  await legacy([phrase('first',{screenshot:images[0]}),phrase('second',{screenshot:images[1],capturedAt:now+100})],[]);
  const migrated=(await getData()).phrases[0];assert.equal(migrated.screenshots?.length,2);
  for(let i=0;i<10;i++){
    const screenshot=`data:image/png;base64,${Buffer.from(`new-frame-${i}`).toString('base64')}`;
    const saved=await savePhrase(phrase(`capture-${i}`,{screenshot,lastSeenAt:now+200+i}));
    assert.equal(saved.screenshot,screenshot);
    assert.deepEqual(new Set(saved.screenshots),new Set(images.slice(0,2)));
    assert.equal(saved.seenCount,3+i);
    const beforeReplay=await getData();await importData(await exportData());
    assert.deepEqual(await getData(),beforeReplay,'a canonical backup replay does not archive each new live preview');
  }
  const first=await savePhrase(phrase('plain',{text:'別の言葉',screenshot:images[0]}));
  const second=await savePhrase({...first,id:'plain-again',screenshot:images[1]});
  assert.equal(second.screenshot,images[1]);assert.equal(second.screenshots,undefined,'normal observations do not start an image archive');
});

test('replaying an original-ID backup after fresh captures never archives their live previews',async()=>{
  const first=phrase('first',{screenshot:images[0]}),old=phrase('retired',{screenshot:images[1],capturedAt:now+100});
  await legacy([first,old],[]);
  const backup={version:1,phrases:[old],attempts:[],sessions:[],settings:DEFAULT_SETTINGS};
  for(let i=0;i<5;i++){
    const screenshot=`data:image/png;base64,${Buffer.from(`live-preview-${i}`).toString('base64')}`;
    const captured=await savePhrase(phrase(`capture-${i}`,{screenshot,lastSeenAt:now+200+i}));
    assert.equal(captured.screenshot,screenshot);
    await importData(backup);
    const replayed=(await getData()).phrases[0];
    assert.equal(replayed.seenCount,captured.seenCount,'the known original ID adds no count');
    assert.deepEqual(new Set(replayed.screenshots),new Set(images.slice(0,2)),'the existing archive is authoritative; a live preview is not a new original');
  }
  await importData({...backup,phrases:[phrase('new-original',{screenshot:images[2]})]});
  assert.deepEqual(new Set((await getData()).phrases[0].screenshots),new Set(images),'a genuinely new original image is retained');
});

test('an attempt-only import revalidates detailed input instead of reviving a corrected spelling',async()=>{
  const original=await savePhrase(phrase('p1',{text:'ペアルック',reading:'ぺあるっく',roman:'pearukku',verified:true}));
  await saveSession(session());
  const earlier=attempt(original,'earlier');await saveAttempt(earlier);
  const edited=await updatePhrase(original.id,{reading:'ぺあるく',roman:'pearuku'});
  assert.equal((await getData()).attempts[0].reliable,false);
  const current=attempt(edited,'current');
  await importData({version:1,phrases:[],attempts:[earlier,current],sessions:[],settings:DEFAULT_SETTINGS});
  const data=await getData();
  assert.deepEqual(data.attempts.find(value=>value.id===earlier.id),{...earlier,reliable:false},'the import retains old measurements without restoring analysis eligibility');
  assert.equal(data.attempts.find(value=>value.id===current.id)?.reliable,true,'compatible detailed input remains usable');
  assert.equal(analyzeWords(data.attempts,data.phrases)[0].attempts,1);
  const legacy={...current,id:'with-original-definition'};delete legacy.judgements;
  await importData({version:1,phrases:[edited],attempts:[legacy],sessions:[],settings:DEFAULT_SETTINGS});
  assert.deepEqual((await getData()).attempts.find(value=>value.id===legacy.id),legacy,'an original phrase supplied by the backup still proves compatible legacy input');
});

test('merged count and image limits reject the entire operation instead of creating an unrestorable record',async()=>{
  await savePhrase(phrase('full',{seenCount:1000000}));const before=await getData();
  await assert.rejects(savePhrase(phrase('one-too-many')),/出題回数/);
  assert.deepEqual(await getData(),before);
  const pictures=Array.from({length:1001},(_,i)=>`data:image/png;base64,${Buffer.from(`image-${i}`).toString('base64')}`);
  const a=phrase('images-a',{text:'画像の語句',screenshot:pictures[0],screenshots:pictures.slice(0,501)});
  const b=phrase('images-b',{text:'画像の語句',screenshot:pictures[501],screenshots:pictures.slice(501)});
  await assert.rejects(importData({version:1,phrases:[a,b],attempts:[],sessions:[],settings:DEFAULT_SETTINGS}),/保存画像/);
  assert.deepEqual(await getData(),before);
});

test('a consolidation overflow rolls back the whole v2 upgrade, including aliases and reference moves',async()=>{
  const a=phrase('full',{seenCount:1000000}),b=phrase('extra'),history=attempt(b,'retained');
  await legacy([a,b],[history]);
  await assert.rejects(getData(),/出題回数/);
  const db=await requested(indexedDB.open(name));
  try{
    assert.equal(db.version,2);assert.equal(db.objectStoreNames.contains('phraseAliases'),false);
    const tx=db.transaction(['phrases','attempts','sessions'],'readonly'),done=completed(tx);
    const [phrases,attempts,sessions]=await Promise.all([requested(tx.objectStore('phrases').getAll()),requested(tx.objectStore('attempts').getAll()),requested(tx.objectStore('sessions').getAll())]);
    await done;
    assert.deepEqual(phrases,[b,a]);assert.deepEqual(attempts,[history]);assert.deepEqual(sessions,[session()]);
  }finally{db.close();}
});

test('a single distinct original image remains archived after duplicate rows merge and a later capture replaces the preview',async()=>{
  for(const repeatedImage of [true,false]){
    if(!repeatedImage)await remove();
    await legacy([phrase('a',{screenshot:images[0]}),phrase('b',{capturedAt:now+100,...(repeatedImage?{screenshot:images[0]}:{})})],[]);
    const merged=(await getData()).phrases[0];
    assert.deepEqual(merged.screenshots,[images[0]]);
    const later=await savePhrase(phrase('new-capture',{screenshot:images[1],lastSeenAt:now+1000}));
    assert.equal(later.screenshot,images[1]);assert.deepEqual(later.screenshots,[images[0]]);
    const backup=await exportData();await importData(backup);
    assert.deepEqual((await getData()).phrases[0],later);
  }
});

test('legacy original-ID imports update that source count while canonical save snapshots remain aggregate counts',async()=>{
  const a=phrase('a',{seenCount:3}),b=phrase('b',{seenCount:4,capturedAt:now+100});
  await legacy([a,b],[]);
  assert.equal((await getData()).phrases[0].seenCount,7);
  const incoming={version:1,phrases:[{...a,seenCount:5}],attempts:[],sessions:[],settings:DEFAULT_SETTINGS};
  await importData(incoming);await importData(incoming);
  const merged=(await getData()).phrases[0];
  assert.equal(merged.seenCount,9);assert.deepEqual(merged.seenSources,[{id:'a',count:5},{id:'b',count:4}]);
  const saved=await savePhrase({...merged,seenSources:undefined});
  assert.equal(saved.seenCount,9);assert.deepEqual(saved.seenSources,merged.seenSources);
});

test('delayed detailed input is rechecked against a corrected target even when the canonical ID stays the same',async()=>{
  const wrong=await savePhrase(phrase('earlier',{text:'ペアルク',reading:'ぺあるく',roman:'pearuku'}));
  const correct=await savePhrase(phrase('later',{text:'ペアルック',reading:'ぺあるっく',roman:'pearukku',capturedAt:now+100,verified:true}));
  await saveSession(session());
  const pending=attempt(wrong,'delayed');
  const canonical=await updatePhrase(wrong.id,{text:correct.text,reading:correct.reading,roman:correct.roman,verified:true});
  assert.equal(canonical.id,wrong.id);
  await saveAttempt(pending);
  const stored=(await getData()).attempts.find(value=>value.id===pending.id)!;
  assert.deepEqual(stored,{...pending,reliable:false});
  const current=attempt(canonical,'current','pearukku');await saveAttempt(current);
  assert.equal((await getData()).attempts.find(value=>value.id===current.id)?.reliable,true);
  // A partial legacy backup without its original phrase or detailed judgements
  // is preserved, but cannot prove compatibility with the corrected spelling.
  const legacyAttempt={...pending,id:'legacy-without-detail'};delete legacyAttempt.judgements;
  await importData({version:1,phrases:[],attempts:[legacyAttempt],sessions:[],settings:DEFAULT_SETTINGS});
  assert.deepEqual((await getData()).attempts.find(value=>value.id===legacyAttempt.id),{...legacyAttempt,reliable:false});
});

test('clause history follows a unique shifted clause through edits, late saves and backup replay', async t => {
  const parent = await savePhrase(phrase('long',{text:'開いた口が塞がらない',reading:'あいたくちがふさがらない',roman:'aitakutigahusagaranai',verified:true}));
  await saveSession(session());
  const target = clauseTarget(parent,{text:'口が',reading:'くちが',start:3});
  const drill = buildAttempt({phrase:target,strokes:[...'kuchiga'].map((key,i)=>({key,at:now+(i+1)*100})),
    startedAt:now,endedAt:now+1000,sessionId:'game',source:'practice',complete:true,reliable:true});
  await saveAttempt(drill);
  await saveAttempt({...drill,id:'repeat'});
  const parse = t.mock.method(Parser.prototype,'parse');
  await updatePhrase(parent.id,{reading:'ひらいたくちがふさがらない',roman:'hiraitakutigahusagaranai'});
  assert.equal(parse.mock.callCount(),1,'edit splits the parent once for all of its drills');
  await saveAttempt({...drill,id:'late'});
  const backup = await exportData();
  parse.mock.resetCalls();
  await importData({...backup,attempts:[{...drill,id:'from-backup'},{...drill,id:'another-import'}]});
  assert.equal(parse.mock.callCount(),1,'restore splits the shared target once');
  const rows = (await getData()).attempts;
  assert.equal(rows.length,5);
  assert.ok(rows.every(a=>a.reliable && a.clause?.start===4));
  await updatePhrase(parent.id,{text:'口が開いた口が塞がらない',reading:'くちがあいたくちがふさがらない',roman:'kutigaaitakutigahusagaranai'});
  const ambiguous = (await getData()).attempts;
  assert.ok(ambiguous.every(a=>!a.reliable && a.clause?.start===4));
});
