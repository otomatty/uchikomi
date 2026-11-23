import 'fake-indexeddb/auto';
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import { clearData,getData,savePhrase,updatePhrase,deletePhrase,saveAttempt,saveSession,updateSettings,exportData,importData,subscribe } from '../src/core/db';
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
function session(id='s1'):Session{return {id,startedAt:now,endedAt:now+2000,source:'practice',scoreType:'profit',course:10000,mode:'accuracy',phraseCount:1,correctKeys:8,mistakes:1,durationMs:2000};}
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
  const returned=await savePhrase({...phrase('later'),reading:'ぺあるく',confidence:61,verified:false,lastSeenAt:now+9000});
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
