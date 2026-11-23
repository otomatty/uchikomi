import 'fake-indexeddb/auto';
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import { clearData,getData,savePhrase,updatePhrase,deletePhrase,saveAttempt,saveSession,saveAutomaticScore,updateSettings,exportData,importData,subscribe } from '../src/core/db';
import { buildAttempt, summarize } from '../src/core/analytics';
import { DEFAULT_SETTINGS } from '../src/core/types';
import type { Phrase,Attempt,Session } from '../src/core/types';
// The Node BroadcastChannel would keep the test process alive. This deterministic peer channel
// exercises the same no-self-delivery contract without opening host IPC resources.
const nativeChannel=globalThis.BroadcastChannel;
class TestBroadcastChannel {
  static channels=new Set<TestBroadcastChannel>();onmessage:((event:{data:unknown})=>void)|null=null;
  constructor(public name:string){TestBroadcastChannel.channels.add(this);}
  postMessage(data:unknown){for(const peer of TestBroadcastChannel.channels)if(peer!==this&&peer.name===this.name)peer.onmessage?.({data});}
  close(){TestBroadcastChannel.channels.delete(this);}
}
(globalThis as any).BroadcastChannel=TestBroadcastChannel;
after(()=>{for(const c of TestBroadcastChannel.channels)c.close();globalThis.BroadcastChannel=nativeChannel;});
beforeEach(async()=>{await clearData();});
const now=1760000000000;
function phrase(id='p1',text='ペアルック',reading='ぺあるっく',roman='pearukku'):Phrase{return {id,text,reading,roman,source:'capture',confidence:92,verified:true,capturedAt:now,lastSeenAt:now,seenCount:1};}
function session(id='s1'):Session{return {id,startedAt:now,endedAt:now+2000,source:'practice',scoreType:'total',course:10000,mode:'accuracy',phraseCount:1,correctKeys:8,mistakes:1,durationMs:2000};}
function attempt(id='a1',phraseId='p1',sessionId='s1'):Attempt{return {id,phraseId,sessionId,source:'practice',startedAt:now,endedAt:now+2000,durationMs:2000,correctKeys:8,mistakes:1,accuracy:8/9*100,kps:4,samples:[{pattern:'kk',intervalMs:200,error:true,at:now+1600}],complete:true,reliable:true,typed:'pearukku'};}
async function seed(){await savePhrase(phrase());await saveSession(session());await saveAttempt(attempt());}

test('first run is empty with deterministic defaults; settings persist',async()=>{
  const initial=await getData();assert.deepEqual(initial,{phrases:[],attempts:[],sessions:[],settings:DEFAULT_SETTINGS});
  await updateSettings({targetScore:35000,scoreType:'total'});const saved=await getData();assert.equal(saved.settings.targetScore,35000);assert.equal(saved.settings.scoreType,'total');assert.equal(saved.settings.baselineScore,18000);
});
test('concurrent repeated captures deduplicate atomically and return one canonical ID',async()=>{
  const [a,b]=await Promise.all([savePhrase({...phrase('first'),verified:false}),savePhrase({...phrase('second'),verified:false,lastSeenAt:now+5000})]);
  assert.equal(a.id,b.id);const data=await getData();assert.equal(data.phrases.length,1);assert.equal(data.phrases[0].seenCount,2);assert.equal(data.phrases[0].lastSeenAt,now+5000);
});
test('confirmed text survives lower-quality OCR observations',async()=>{
  const p=await savePhrase(phrase());
  const returned=await savePhrase({...phrase('later'),reading:'',confidence:61,verified:false,lastSeenAt:now+9000});
  assert.equal(returned.id,p.id);assert.equal(returned.reading,p.reading);assert.equal(returned.verified,true);assert.equal(returned.confidence,92);assert.equal(returned.seenCount,2);
});
test('editing roman or reading preserves history but invalidates stale analysis atomically',async()=>{
  await seed();await savePhrase(phrase('p2','刺身','さしみ','sasimi'));await saveAttempt(attempt('a2','p2'));
  await updatePhrase('p1',{reading:'ぺあるく',roman:'pearuku'});
  const data=await getData();assert.equal(data.attempts.length,2);assert.equal(data.attempts.find(a=>a.id==='a1')?.reliable,false);assert.equal(data.attempts.find(a=>a.id==='a2')?.reliable,true);
  assert.equal(data.phrases.find(p=>p.id==='p1')?.roman,'pearuku');
});
test('confirmation-only and label-only edits retain valid timing measurements',async()=>{
  await seed();await updatePhrase('p1',{text:'ペアルック（確認済み）',verified:true});assert.equal((await getData()).attempts[0].reliable,true);
});
test('invalid phrase or setting edits roll back the write transaction',async()=>{
  await seed();const before=await getData();
  await assert.rejects(updatePhrase('p1',{roman:'日本語'}));
  await assert.rejects(updateSettings({targetDate:'2026-02-31'}));
  assert.deepEqual(await getData(),before);
});
test('deleting one phrase cascades only its attempts and preserves other history',async()=>{
  await seed();await savePhrase(phrase('p2','刺身','さしみ','sasimi'));await saveAttempt(attempt('a2','p2'));
  await deletePhrase('p1');const data=await getData();assert.deepEqual(data.phrases.map(p=>p.id),['p2']);assert.deepEqual(data.attempts.map(a=>a.id),['a2']);assert.equal(data.sessions.length,1);
});
test('export/import roundtrip restores a partial practice with its initial session',async()=>{
  await savePhrase(phrase());const initialSession=session();delete initialSession.endedAt;initialSession.phraseCount=0;await saveSession(initialSession);await saveAttempt(attempt());
  const backup=await exportData();await clearData();await importData(JSON.parse(JSON.stringify(backup)));
  const roundtrip=await exportData();assert.deepEqual(roundtrip.phrases,backup.phrases);assert.deepEqual(roundtrip.attempts,backup.attempts);assert.deepEqual(roundtrip.sessions,backup.sessions);assert.deepEqual(roundtrip.settings,backup.settings);
});
test('exports validate standalone restore compatibility and preserve all records and images',async()=>{
  const screenshot='data:image/png;base64,AA==',evidence='data:image/png;base64,AQ==';
  await savePhrase({...phrase(),screenshot,tags:Array.from({length:20},(_,i)=>`tag-${i}`)});
  // Individual attempt saves can precede their session, but a standalone backup
  // of that intermediate state could not be restored into an empty profile.
  await saveAttempt(attempt());const withoutSession=await getData();
  await assert.rejects(exportData(),/参照する語句・セッション/);
  assert.deepEqual(await getData(),withoutSession);
  await saveSession({...session(),source:'capture'});
  await saveAutomaticScore('s1',{score:18000,scoreType:'total',scoreConfidence:95,scoreObservedAt:now+2000,scoreEvidence:evidence});
  const original=await getData(),backup=await exportData();
  assert.equal(backup.version,1);assert.equal(backup.phrases[0].screenshot,screenshot);assert.equal(backup.sessions[0].scoreEvidence,evidence);
  await clearData();await importData(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(await getData(),original);
  // Individually valid captures cannot create a merged record outside the
  // restore limits. Reject the complete write without silently dropping tags.
  await assert.rejects(savePhrase({...phrase('repeat'),tags:['one-more']}),/タグ/);
  assert.deepEqual(await getData(),original);
  assert.deepEqual((await exportData()).phrases,backup.phrases);
});
test('malformed import and dangling references do not partially overwrite existing records',async()=>{
  await seed();const before=await getData();
  await assert.rejects(importData({version:1,...before,phrases:[{...phrase('new'),text:'New phrase'}],attempts:[attempt('newAttempt','missing')],sessions:[session('newSession')],settings:{...DEFAULT_SETTINGS,targetScore:99999}}));
  assert.deepEqual(await getData(),before);
  await assert.rejects(importData({version:1,...before,attempts:[{...attempt(),accuracy:Infinity}]}));assert.deepEqual(await getData(),before);
});
test('valid merge preserves unrelated IDs and can refer to existing records',async()=>{
  await seed();await importData({version:1,phrases:[phrase('p2','刺身','さしみ','sasimi')],attempts:[attempt('a2','p2','s1')],sessions:[],settings:{...DEFAULT_SETTINGS,targetScore:32000}});
  const data=await getData();assert.equal(data.phrases.length,2);assert.equal(data.attempts.length,2);assert.equal(data.sessions.length,1);assert.equal(data.settings.targetScore,32000);
});
test('merging a changed spelling invalidates only retained attempts while preserving imported replacements',async()=>{
  await seed();await saveAttempt(attempt('replace'));
  const unrelated=phrase('p2','刺身','さしみ','sasimi');await savePhrase(unrelated);await saveAttempt(attempt('other','p2'));
  const revised={...phrase(),reading:'ぺあるく',roman:'pearuku'};
  const replacement={...buildAttempt({phrase:revised,strokes:[...'pearuku'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+1000,sessionId:'s1',source:'practice',complete:true,reliable:true}),id:'replace'};
  await importData({version:1,phrases:[revised,{...unrelated,text:'刺身（確認済み）'}],attempts:[replacement],sessions:[],settings:DEFAULT_SETTINGS});
  const data=await getData();assert.equal(data.attempts.length,3);
  const retained=data.attempts.find(a=>a.id==='a1')!;
  assert.equal(retained.reliable,false);assert.equal(retained.typed,'pearukku');
  assert.deepEqual(data.attempts.find(a=>a.id==='replace'),replacement);
  assert.equal(data.attempts.find(a=>a.id==='other')?.reliable,true);
  assert.equal(data.phrases.find(p=>p.id==='p1')?.roman,'pearuku');
});
test('local and cross-context notifications each fire once without feedback loops',async()=>{
  let updates=0;const unsubscribe=subscribe(()=>{updates++;});await savePhrase(phrase());assert.equal(updates,1);
  const peer=new TestBroadcastChannel('uchikomi-changes');let echoes=0;peer.onmessage=()=>echoes++;peer.postMessage({changedAt:now});assert.equal(updates,2);assert.equal(echoes,0);
  unsubscribe();await updateSettings({targetScore:31000});assert.equal(updates,2);assert.equal(echoes,1);peer.close();
});
test('clearData removes every store together and returns default settings',async()=>{
  await seed();await updateSettings({targetScore:33000});await clearData();assert.deepEqual(await getData(),{phrases:[],attempts:[],sessions:[],settings:DEFAULT_SETTINGS});
});

test('demo data cannot be persisted or imported into actual records',async()=>{
  await assert.rejects(savePhrase({...phrase(),source:'demo'}));
  await assert.rejects(saveSession({...session(),source:'demo'}));
  await seed();const before=await getData();
  await assert.rejects(saveAttempt({...attempt('demoAttempt'),source:'demo'}));
  await assert.rejects(importData({...before,version:1,phrases:[{...phrase('demoWord'),source:'demo'}]}));
  assert.deepEqual(await getData(),before);
});

test('detailed actual and expected keystrokes survive backup and malformed detail rolls back atomically',async()=>{
  const p=phrase();await savePhrase(p);await saveSession(session());
  const detailed=buildAttempt({phrase:p,strokes:[...'peaqrukku'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+2000,sessionId:'s1',source:'practice',complete:true,reliable:true});
  await saveAttempt(detailed);const backup=await exportData();
  assert.equal(backup.attempts[0].judgements?.[3].actual,'q');assert.deepEqual(backup.attempts[0].judgements?.[3].expected,['r']);
  await clearData();await importData(JSON.parse(JSON.stringify(backup)));assert.deepEqual((await getData()).attempts[0].judgements,detailed.judgements);
  const before=await getData();
  const malformed=JSON.parse(JSON.stringify(backup));malformed.attempts[0].judgements[3].accepted=true;
  await assert.rejects(importData(malformed));assert.deepEqual(await getData(),before);
});

test('automatic totals survive asynchronous session-count writes without storing a profit amount',async()=>{
  const captured:Session={...session(),source:'capture',captureId:'recording-1',scoreReview:{score:18000,scoreType:'total',confidence:64,observedAt:now+1500,reason:'数値を確認'}};
  await saveSession(captured);assert.equal(summarize(await getData()).best,null);
  assert.equal(await saveAutomaticScore('s1',{score:18000,scoreType:'total',scoreConfidence:94,scoreObservedAt:now+2000,scoreEvidence:'data:image/png;base64,AA==',scoreModeSource:'configured'}),true);
  await saveSession({...captured,phraseCount:7});
  const saved=(await getData()).sessions[0];assert.equal(saved.score,18000);assert.equal(saved.scoreSource,'ocr');assert.equal(saved.scoreTotal,18000);assert.equal('scoreProfit' in saved,false);assert.equal(saved.phraseCount,7);assert.equal(saved.scoreReview,undefined);
  assert.equal(saved.scoreModeSource,'configured');
  assert.equal(await saveAutomaticScore('s1',{score:18000,scoreType:'total',scoreConfidence:99,scoreObservedAt:now+3000}),false);
  const backup=await exportData();await clearData();await importData(JSON.parse(JSON.stringify(backup)));assert.deepEqual((await getData()).sessions,backup.sessions);
});

test('manual and legacy score corrections cannot be overwritten by OCR or stale capture objects',async()=>{
  const captured:Session={...session(),source:'capture'};await saveSession(captured);
  await saveAutomaticScore('s1',{score:18000,scoreType:'total',scoreConfidence:95,scoreObservedAt:now+2000});
  const automatic=(await getData()).sessions[0];await saveSession({...automatic,score:19000,scoreSource:'manual'});
  assert.equal(await saveAutomaticScore('s1',{score:20000,scoreType:'total',scoreConfidence:99,scoreObservedAt:now+4000}),false);
  await saveSession({...automatic,phraseCount:10,score:22000,scoreTotal:22000,scoreObservedAt:Date.now()+1000});
  let saved=(await getData()).sessions[0];assert.equal(saved.score,19000);assert.equal(saved.scoreSource,'manual');assert.equal(saved.scoreConfidence,undefined);assert.equal(saved.scoreEvidence,undefined);assert.equal(saved.scoreTotal,19000);assert.equal(saved.phraseCount,10);
  await saveSession({...captured,id:'legacy',score:17000});
  assert.equal(await saveAutomaticScore('legacy',{score:21000,scoreType:'total',scoreConfidence:99,scoreObservedAt:now+4000}),false);
  saved=(await getData()).sessions.find(s=>s.id==='legacy')!;assert.equal(saved.score,17000);
});

test('pending score review persists without affecting graphs and invalid score evidence is rejected',async()=>{
  const captured:Session={...session(),source:'capture'};await saveSession(captured);
  await saveSession({...captured,scoreReview:{score:18000,scoreType:'total',confidence:60,observedAt:now+1000,reason:'数値が一致しません',evidence:'data:image/png;base64,AA=='}});
  await saveSession({...captured,phraseCount:5});const before=await getData();
  assert.equal(before.sessions[0].scoreReview?.score,18000);assert.equal(before.sessions[0].score,undefined);assert.equal(summarize(before).best,null);
  await assert.rejects(saveAutomaticScore('s1',{score:18000,scoreType:'total',scoreConfidence:95,scoreObservedAt:now+3000,scoreTotal:30000}));
  await assert.rejects(importData({...before,version:1,sessions:[{...before.sessions[0],scoreReview:{...before.sessions[0].scoreReview,evidence:'https://example.com/image.png'}}]}));
  await assert.rejects(importData({...before,version:1,sessions:[{...before.sessions[0],scoreModeSource:'inferred'}]}));
  assert.deepEqual(await getData(),before);
});

test('concurrent manual and automatic score saves always preserve the manual correction',async()=>{
  const captured:Session={...session(),source:'capture'};await saveSession(captured);
  await Promise.all([
    saveAutomaticScore('s1',{score:18000,scoreType:'total',scoreConfidence:95,scoreObservedAt:now+2000}),
    saveSession({...captured,score:19500,scoreSource:'manual'}),
  ]);
  const saved=(await getData()).sessions[0];assert.equal(saved.score,19500);assert.equal(saved.scoreSource,'manual');
});

test('terminal-miss captures roundtrip and forged termination flags are rejected before any import mutation',async()=>{
  const p=phrase();await savePhrase(p);await saveSession({...session(),source:'capture'});
  const terminal=buildAttempt({phrase:p,strokes:[...'peaqnextplate'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+2000,sessionId:'s1',source:'capture',complete:false,reliable:true,endOnMistake:true});
  await saveAttempt(terminal);const backup=await exportData();
  await clearData();await importData(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual((await getData()).attempts[0],terminal);
  const before=await getData();
  const wrongPatches=[
    {errorTerminated:'true'},
    {source:'practice'},
    {complete:true},
    {judgements:undefined},
    {endedAt:terminal.endedAt+100,durationMs:terminal.durationMs+100},
    {durationMs:terminal.durationMs+100},
    {typed:'pear'},
    {samples:[...terminal.samples,{pattern:'ru',intervalMs:100,error:false,at:terminal.endedAt+100}]},
    {judgements:terminal.judgements!.slice(0,-1),mistakes:0},
  ];
  for(const patch of wrongPatches){
    await assert.rejects(importData({...backup,attempts:[{...terminal,...patch}],settings:{...backup.settings,targetScore:99999}}));
    assert.deepEqual(await getData(),before);
  }
  const corrected=buildAttempt({phrase:p,strokes:[...'peaqrukku'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+1000,sessionId:'s1',source:'practice',complete:true,reliable:true});
  await assert.rejects(saveAttempt({...corrected,source:'capture',complete:false,errorTerminated:true}));
  assert.deepEqual(await getData(),before);
});

test('legacy backups convert profit observations once, retain totals, and export only total money fields',async()=>{
  const evidence='data:image/png;base64,AQ==';
  const oldSettings={...DEFAULT_SETTINGS,scoreType:'profit',sessionLength:15};
  const old={version:1,phrases:[{...phrase(),screenshot:evidence}],attempts:[attempt('legacy-attempt','p1','profit')],settings:oldSettings,sessions:[
    {...session('profit'),source:'capture',score:18000,scoreType:'profit',scoreTotal:28000,scoreProfit:18000,scoreSource:'ocr',scoreConfidence:95,scoreObservedAt:now+2000,scoreEvidence:evidence},
    {...session('total'),source:'manual',score:28000,scoreType:'total',scoreTotal:28000,scoreProfit:18000},
    {...session('review'),source:'capture',scoreType:'profit',scoreReview:{score:-800,scoreType:'profit',confidence:64,observedAt:now+1500,reason:'数字を確認',evidence}},
  ]};
  await importData(old);const converted=await getData();
  assert.equal(converted.sessions.find(s=>s.id==='profit')?.score,28000);
  assert.equal(converted.sessions.find(s=>s.id==='total')?.score,28000);
  const review=converted.sessions.find(s=>s.id==='review')!;
  assert.equal(review.score,undefined);assert.equal(review.scoreReview?.score,9200);assert.equal(review.scoreReview?.evidence,evidence);
  assert.deepEqual(converted.phrases,old.phrases);assert.deepEqual(converted.attempts,old.attempts);
  assert.deepEqual(converted.settings,{...oldSettings,scoreType:'total'});
  assert.equal(converted.settings.targetScore,30000);assert.equal(converted.settings.baselineScore,18000);
  const backup=await exportData();assert.equal(backup.version,1);
  assert.equal(JSON.stringify(backup).includes('"scoreProfit"'),false);
  assert.ok(backup.sessions.every(s=>s.scoreType==='total'&&(!s.scoreReview||s.scoreReview.scoreType==='total')));
  await clearData();await importData(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(await getData(),converted);
});

test('contradictory legacy totals stay in review with all candidates and existing evidence preserved',async()=>{
  const evidence='data:image/png;base64,AA==',previousEvidence='data:image/png;base64,AQ==';
  await importData({version:1,phrases:[],attempts:[],settings:DEFAULT_SETTINGS,sessions:[{
    ...session('conflict'),source:'capture',scoreType:'profit',score:18000,scoreTotal:29000,scoreProfit:18000,
    scoreSource:'ocr',scoreConfidence:95,scoreObservedAt:now+2000,scoreEvidence:evidence,
    scoreReview:{score:17500,scoreType:'profit',confidence:60,observedAt:now+1500,reason:'前の数字を確認',evidence:previousEvidence},
  }]});
  const data=await getData(),result=data.sessions[0];
  assert.equal(result.score,undefined);assert.equal(result.scoreTotal,undefined);assert.equal(result.scoreReview?.score,undefined);
  assert.equal(result.scoreType,'total');assert.equal(result.scoreReview?.scoreType,'total');assert.equal('scoreProfit' in result,false);
  assert.match(result.scoreReview!.reason,/合計金額の候補が一致しません/);
  for(const value of ['28000','29000','27500','前の数字を確認'])assert.ok(result.scoreReview!.reason.includes(value));
  assert.equal(result.scoreEvidence,evidence);assert.equal(result.scoreReview?.evidence,previousEvidence);
  assert.equal(result.scoreReview?.observedAt,now+1500);assert.equal(result.scoreObservedAt,now+2000);
  assert.equal(summarize(data).best,null);
  const backup=await exportData();await clearData();await importData(backup);assert.deepEqual(await getData(),data);
});

test('ordinary score and settings writes reject legacy profit units instead of interpreting them as totals',async()=>{
  await saveSession({...session(),source:'capture'});const before=await getData();
  await assert.rejects(saveSession({...session(),score:18000,scoreType:'profit'} as unknown as Session));
  await assert.rejects(saveAutomaticScore('s1',{score:18000,scoreType:'profit',scoreConfidence:95,scoreObservedAt:now+2000} as any));
  await assert.rejects(updateSettings({scoreType:'profit'} as any));
  await assert.rejects(saveAutomaticScore('s1',{score:18000,scoreType:'total',scoreConfidence:95,scoreObservedAt:now+2000,scoreTotal:28000}));
  assert.deepEqual(await getData(),before);
});
