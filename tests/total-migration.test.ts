import 'fake-indexeddb/auto';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { getData,exportData } from '../src/core/db';
import { buildAttempt } from '../src/core/analytics';
import { DEFAULT_SETTINGS } from '../src/core/types';
import type { Phrase } from '../src/core/types';

const name='uchikomi-v1',now=1760000000000;
const image='data:image/png;base64,AA==',reviewImage='data:image/png;base64,AQ==';
const phrase:Phrase={id:'p1',text:'写真',reading:'しゃしん',roman:'syasinn',source:'capture',confidence:95,verified:true,capturedAt:now,lastSeenAt:now+1000,seenCount:7,screenshot:image,tags:['確認済み']};
const attempt=buildAttempt({phrase,strokes:[...'shq'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+1000,sessionId:'a-profit',source:'capture',complete:false,reliable:true,endOnMistake:true});
const settings={...DEFAULT_SETTINGS,scoreType:'profit',sessionLength:15,calibration:{japanese:{x:.1,y:.2,width:.7,height:.1},roman:{x:.1,y:.4,width:.7,height:.1},updatedAt:now}};
const base=(id:string)=>({id,startedAt:now,endedAt:now+2000,source:'capture',scoreType:'profit',course:10000,mode:'accuracy',phraseCount:7,correctKeys:50,mistakes:3,durationMs:2000,captureId:'capture-original'});

const requested=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const completed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);});
async function removeDatabase(){await requested(indexedDB.deleteDatabase(name));}
beforeEach(removeDatabase);afterEach(removeDatabase);

async function legacyDatabase(sessions:Record<string,unknown>[]):Promise<IDBDatabase>{
  const opening=indexedDB.open(name,1);
  opening.onupgradeneeded=()=>{
    const db=opening.result;
    db.createObjectStore('phrases',{keyPath:'id'});
    const attempts=db.createObjectStore('attempts',{keyPath:'id'});
    attempts.createIndex('phraseId','phraseId');attempts.createIndex('sessionId','sessionId');
    db.createObjectStore('sessions',{keyPath:'id'});db.createObjectStore('settings');
  };
  const db=await requested(opening),tx=db.transaction(['phrases','attempts','sessions','settings'],'readwrite'),done=completed(tx);
  tx.objectStore('phrases').put(phrase);tx.objectStore('attempts').put(attempt);
  for(const session of sessions)tx.objectStore('sessions').put(session);
  tx.objectStore('settings').put(settings,'main');await done;return db;
}

test('opening the old IndexedDB upgrades all money once while retaining phrases, images, keys, settings and timestamps',async t=>{
  const oldSessions=[
    {...base('a-profit'),score:18000,scoreTotal:28000,scoreProfit:18000,scoreSource:'ocr',scoreConfidence:95,scoreObservedAt:now+1700,scoreEvidence:image,scoreModeSource:'configured'},
    {...base('b-total'),scoreType:'total',score:35000,scoreTotal:35000,scoreProfit:25000,scoreSource:'manual',scoreObservedAt:now+1800},
    {...base('c-loss'),score:-800,scoreTotal:9200,scoreProfit:-800},
    {...base('d-zero'),score:-10000,scoreTotal:0,scoreProfit:-10000},
    {...base('e-review'),scoreReview:{score:19000,scoreType:'profit',confidence:60,observedAt:now+1300,reason:'数字を確認',evidence:reviewImage}},
    {...base('f-conflict'),score:18000,scoreTotal:29000,scoreProfit:18000,scoreEvidence:image,
      scoreReview:{score:17000,scoreType:'profit',confidence:55,observedAt:now+1200,reason:'前の候補を確認',evidence:reviewImage}},
  ];
  const legacy=await legacyDatabase(oldSessions);t.after(()=>legacy.close());
  const changes:{oldVersion:number;newVersion:number|null}[]=[];
  legacy.onversionchange=event=>{changes.push({oldVersion:event.oldVersion,newVersion:event.newVersion});legacy.close();};
  const data=await getData();
  assert.deepEqual(changes,[{oldVersion:1,newVersion:2}]);
  assert.deepEqual(data.phrases,[phrase]);assert.deepEqual(data.attempts,[attempt]);
  assert.deepEqual(data.settings,{...settings,scoreType:'total'});
  assert.equal(data.settings.targetScore,30000);assert.equal(data.settings.baselineScore,18000);
  assert.equal(data.sessions.length,oldSessions.length);
  const scores=new Map(data.sessions.map(session=>[session.id,session]));
  assert.equal(scores.get('a-profit')?.score,28000);assert.equal(scores.get('b-total')?.score,35000);
  assert.equal(scores.get('c-loss')?.score,9200);assert.equal(scores.get('d-zero')?.score,0);
  assert.equal(scores.get('a-profit')?.scoreEvidence,image);assert.equal(scores.get('a-profit')?.scoreObservedAt,now+1700);
  assert.equal(scores.get('b-total')?.scoreObservedAt,now+1800);assert.equal(scores.get('a-profit')?.scoreModeSource,'configured');
  assert.equal(scores.get('e-review')?.score,undefined);assert.equal(scores.get('e-review')?.scoreReview?.score,29000);
  assert.equal(scores.get('e-review')?.scoreReview?.evidence,reviewImage);assert.equal(scores.get('e-review')?.scoreReview?.observedAt,now+1300);
  const conflict=scores.get('f-conflict')!;
  assert.equal(conflict.score,undefined);assert.equal(conflict.scoreTotal,undefined);assert.equal(conflict.scoreReview?.score,undefined);
  for(const value of ['28000','29000','27000','前の候補を確認'])assert.ok(conflict.scoreReview!.reason.includes(value));
  assert.equal(conflict.scoreEvidence,image);assert.equal(conflict.scoreReview?.evidence,reviewImage);
  for(const session of data.sessions){
    assert.equal(session.scoreType,'total');assert.equal('scoreProfit' in session,false);
    assert.equal(session.captureId,'capture-original');assert.equal(session.phraseCount,7);assert.equal(session.correctKeys,50);
    assert.equal(session.startedAt,now);assert.equal(session.endedAt,now+2000);assert.equal(session.durationMs,2000);
  }
  const inspect=await requested(indexedDB.open(name));
  try{
    assert.equal(inspect.version,2);
    const tx=inspect.transaction('sessions','readonly'),done=completed(tx),stored=await requested(tx.objectStore('sessions').getAll());await done;
    assert.ok(stored.every(session=>session.scoreType==='total'&&!('scoreProfit' in session)),'conversion is persisted, not just applied by getData');
  }finally{inspect.close();}
  const afterReload=await import('../src/core/db.ts?total-score-migration-reload');
  assert.deepEqual(await afterReload.getData(),data);
  assert.deepEqual(await getData(),data);
  const backup=await exportData();assert.equal(backup.version,1);
  assert.equal(JSON.stringify(backup).includes('"scoreProfit"'),false);
  assert.equal(JSON.stringify(backup).includes('"scoreType":"profit"'),false);
});

test('a failed schema conversion rolls back the entire upgrade and leaves the old data available',async t=>{
  const valid={...base('a-profit'),score:18000,scoreTotal:28000,scoreProfit:18000};
  const invalid={...base('z-invalid'),score:Infinity};
  const legacy=await legacyDatabase([valid,invalid]);t.after(()=>legacy.close());legacy.onversionchange=()=>legacy.close();
  await assert.rejects(getData(),/保存済みの金額/);
  const inspect=await requested(indexedDB.open(name));
  try{
    assert.equal(inspect.version,1);
    const tx=inspect.transaction(['sessions','settings','phrases','attempts'],'readonly'),done=completed(tx);
    const [saved,config,words,inputs]=await Promise.all([
      requested(tx.objectStore('sessions').getAll()),requested(tx.objectStore('settings').get('main')),
      requested(tx.objectStore('phrases').getAll()),requested(tx.objectStore('attempts').getAll()),
    ]);await done;
    assert.deepEqual(saved,[valid,invalid]);assert.deepEqual(config,settings);
    assert.deepEqual(words,[phrase]);assert.deepEqual(inputs,[attempt]);
  }finally{inspect.close();}
});
