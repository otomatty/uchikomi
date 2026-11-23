import 'fake-indexeddb/auto';
import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import { clearData,exportData,getData,importData,saveAutomaticScore,saveSession } from '../src/core/db';
import { dailyTraining } from '../src/core/activity';
import { DEFAULT_SETTINGS } from '../src/core/types';
import type { DailyActivity,Session } from '../src/core/types';

const nativeChannel=globalThis.BroadcastChannel;(globalThis as any).BroadcastChannel=undefined;
after(()=>{globalThis.BroadcastChannel=nativeChannel;});beforeEach(clearData);
const now=Date.parse('2026-12-25T12:00:00+09:00');
const base=(id='game'):Session=>({id,startedAt:now,source:'capture',scoreType:'total',course:10000,mode:'accuracy',phraseCount:2,correctKeys:10,mistakes:1,durationMs:1000});
const row=(date='2026-12-25',activeMs=1000,keys=10,phrases=2):DailyActivity=>({date,activeMs,keys,phrases});

test('cumulative activity survives stale session saves and both automatic and manual score changes',async()=>{
  await saveSession({...base(),activity:[row()]});
  await saveAutomaticScore('game',{score:30000,scoreType:'total',scoreConfidence:95,scoreObservedAt:now+2000});
  await Promise.all([
    saveSession({...base(),activity:[row('2026-12-25',500,8,1)]}),
    saveSession({...base(),activity:[row('2026-12-26',200,3,1)]}),
  ]);
  await saveSession({...base(),score:31000,scoreType:'total',scoreSource:'manual'});
  await saveSession({...base(),activity:[]});
  const saved=(await getData()).sessions[0];
  assert.deepEqual(saved.activity,[row(),row('2026-12-26',200,3,1)]);
  assert.equal(saved.score,31000);assert.equal(saved.scoreSource,'manual');
  assert.equal(await saveAutomaticScore('game',{score:32000,scoreType:'total',scoreConfidence:99,scoreObservedAt:now+5000}),false);
  assert.deepEqual((await getData()).sessions[0].activity,saved.activity);
});

test('backup roundtrip preserves daily records, measured-empty and legacy absence without a schema upgrade',async()=>{
  await saveSession({...base('measured'),activity:[row('2026-12-24',500,4,1),row()]});
  await saveSession({...base('empty'),activity:[],phraseCount:0,correctKeys:0,mistakes:0,durationMs:0});
  await saveSession(base('legacy'));
  const original=await getData(),summary=dailyTraining(original,{today:'2026-12-25',days:7}),backup=await exportData();
  await clearData();await importData(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(await getData(),original);assert.deepEqual(dailyTraining(await getData(),{today:'2026-12-25',days:7}),summary);
  assert.equal(Object.hasOwn((await getData()).sessions.find(value=>value.id==='legacy')!,'activity'),false);
  const opened=indexedDB.open('uchikomi-v1');
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{opened.onsuccess=()=>resolve(opened.result);opened.onerror=()=>reject(opened.error);});
  assert.equal(db.version,3);db.close();
});

test('older or legacy imports cannot erase newer measured activity on an existing session',async()=>{
  await saveSession({...base(),activity:[row()]});
  const backup={version:1,phrases:[],attempts:[],sessions:[base()],settings:DEFAULT_SETTINGS};
  await importData(backup);
  assert.deepEqual((await getData()).sessions[0].activity,[row()]);
  await importData({...backup,sessions:[{...base(),activity:[row('2026-12-25',500,12,1),row('2026-12-26',300,5,1)]}]});
  assert.deepEqual((await getData()).sessions[0].activity,[row('2026-12-25',1000,12,2),row('2026-12-26',300,5,1)]);
});

test('malformed daily records reject saves and imports before changing existing history',async()=>{
  await saveSession({...base(),activity:[row()]});const before=await getData();
  const oversized=Array.from({length:367},(_,i)=>row(new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10),0,0,0));
  const invalid:unknown[]=[null,[{...row(),date:'2026-02-30'}],[{...row(),activeMs:-1}],[{...row(),activeMs:86400001}],[{...row(),keys:1.5}],[{...row(),phrases:-1}],[{...row(),phrases:.5}],[row(),row()],oversized,[row('2026-12-24',50000000),row('2026-12-25',50000000)]];
  for(const activity of invalid){
    await assert.rejects(saveSession({...base(),activity} as Session));
    await assert.rejects(importData({version:1,phrases:[],attempts:[],sessions:[{...base(),activity}],settings:{...DEFAULT_SETTINGS,targetScore:99999}}));
    assert.deepEqual(await getData(),before);
  }
});

test('a monotonic activity merge that exceeds limits rolls back the whole write or import',async()=>{
  await saveSession({...base(),activity:[row('2026-12-24',50000000)]});const before=await getData();
  const overflowing={...base(),activity:[row('2026-12-25',50000000)]};
  await assert.rejects(saveSession(overflowing),/日別の練習記録/);
  assert.deepEqual(await getData(),before);
  await assert.rejects(importData({version:1,phrases:[],attempts:[],sessions:[{...base('would-be-new'),activity:[row()]},overflowing],settings:{...DEFAULT_SETTINGS,targetScore:99999}}),/日別の練習記録/);
  assert.deepEqual(await getData(),before);
});
