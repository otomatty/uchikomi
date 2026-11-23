import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingActivity, dailyTraining, mergeDailyActivity, trainingDateKey } from '../src/core/activity';
import { DEFAULT_SETTINGS } from '../src/core/types';
import type { AppData, Attempt, Session } from '../src/core/types';

const at=(date:string,time='12:00:00')=>Date.parse(`${date}T${time}+09:00`);
const now=at('2026-12-25');
const session=(id:string,patch:Partial<Session>={}):Session=>({id,startedAt:now,source:'capture',scoreType:'total',course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:0,...patch});
const attempt=(id:string,sessionId:string,patch:Partial<Attempt>={}):Attempt=>({id,sessionId,phraseId:'p',source:'capture',startedAt:now,endedAt:now+1000,durationMs:1000,correctKeys:4,mistakes:1,accuracy:80,kps:4,samples:[],complete:false,reliable:false,typed:'test',...patch});
const data=(sessions:Session[]=[],attempts:Attempt[]=[]):AppData=>({phrases:[],sessions,attempts,settings:DEFAULT_SETTINGS});

test('activity measures real key gaps, excludes waiting and pauses, and counts occurrences once',()=>{
  const activity=new TrainingActivity();assert.deepEqual(activity.snapshot(),[]);
  activity.recordPhrase('plate-1',now);activity.recordPhrase('plate-1',now+10);
  for(const offset of [0,500,500,5500,10501,10601])activity.recordKey(now+offset);
  activity.break();activity.recordKey(now+13000);activity.recordKey(now+13100);
  activity.recordPhrase('plate-2',now+13000);
  assert.deepEqual(activity.snapshot(),[{date:'2026-12-25',activeMs:5700,keys:8,phrases:2}]);
  const detached=activity.snapshot();detached[0].keys=1000;
  assert.equal(activity.snapshot()[0].keys,8,'snapshots cannot mutate the live tracker');
});

test('JST midnight and year boundaries split elapsed input time and use each key actual day',()=>{
  const start=at('2026-12-31','23:59:59.500'),activity=new TrainingActivity();
  activity.recordKey(start);activity.recordPhrase('before-midnight',start);
  activity.recordKey(start+2000);activity.recordPhrase('before-midnight',start+2000);activity.recordPhrase('after-midnight',start+2000);
  assert.equal(trainingDateKey(start),'2026-12-31');assert.equal(trainingDateKey(start+500),'2027-01-01');
  assert.deepEqual(activity.snapshot(),[
    {date:'2026-12-31',activeMs:500,keys:1,phrases:1},
    {date:'2027-01-01',activeMs:1500,keys:1,phrases:1},
  ]);
});

test('clock reversal and invalid clocks break timing without inventing missing key dates',()=>{
  const activity=new TrainingActivity();
  activity.recordKey(now);activity.recordKey(now+100);
  activity.recordKey(now+50);activity.recordKey(now+200);activity.recordKey(now+300);
  activity.recordKey(NaN);activity.recordKey(now+400);activity.recordKey(now+500);
  activity.recordPhrase('invalid',Infinity);activity.recordKey(-1);
  assert.deepEqual(activity.snapshot(),[{date:'2026-12-25',activeMs:300,keys:7,phrases:0}]);
  assert.throws(()=>trainingDateKey(Infinity),RangeError);
});

test('measured sessions override attempts, deduplicate snapshots, and fill zero days with source totals',()=>{
  const capture=session('capture',{activity:[{date:'2026-12-23',activeMs:1000,keys:10,phrases:2},{date:'2026-12-25',activeMs:500,keys:5,phrases:1}]});
  const stale={...capture,activity:[{date:'2026-12-23',activeMs:900,keys:8,phrases:1}]};
  const practice=session('practice',{source:'practice',activity:[{date:'2026-12-25',activeMs:700,keys:7,phrases:3}]});
  const ignored=[session('waiting',{activity:[]}),session('manual',{source:'manual',activity:[{date:'2026-12-25',activeMs:9999,keys:999,phrases:999}]}),session('demo',{source:'demo',activity:practice.activity})];
  const summary=dailyTraining(data([capture,stale,practice,...ignored],[attempt('redundant','capture'),attempt('waiting-attempt','waiting'),attempt('manual-attempt','manual')]),{today:'2026-12-25',days:7});
  assert.equal(summary.timeZone,'Asia/Tokyo');assert.equal(summary.from,'2026-12-19');assert.equal(summary.to,'2026-12-25');assert.equal(summary.rows.length,7);
  assert.deepEqual([summary.totals.activeMs,summary.totals.keys,summary.totals.phrases,summary.totals.captureCount,summary.totals.practiceCount],[2200,22,6,1,1]);
  assert.deepEqual([summary.today.activeMs,summary.today.keys,summary.today.phrases,summary.today.captureCount,summary.today.practiceCount],[1200,12,4,0,1]);
  assert.equal(summary.activeDays,2);assert.equal(summary.totals.estimated,false);
  assert.equal(summary.rows[0].keys,0);assert.equal(summary.rows[0].estimated,false);
  assert.equal(summary.totals.capture.records,1);assert.equal(summary.totals.practice.records,1);
});

test('legacy attempts take precedence over session totals and split dated keys and time across midnight',()=>{
  const start=at('2026-12-24','23:59:59'),legacy=attempt('legacy','game',{startedAt:start,endedAt:start+2000,durationMs:2000,correctKeys:2,mistakes:1,judgements:[
    {actual:'a',expected:['a'],accepted:true,position:0,at:start+200},
    {actual:'x',expected:['b'],accepted:false,position:1,at:start+1100},
    {actual:'b',expected:['b'],accepted:true,position:1,at:start+1300},
  ]});
  const saved=session('game',{startedAt:start,endedAt:start+90000,durationMs:90000,correctKeys:1000,mistakes:100,phraseCount:50});
  const fallback=session('practice',{source:'practice',endedAt:now+6000,durationMs:6000,correctKeys:3,mistakes:2,phraseCount:2});
  const summary=dailyTraining(data([saved,fallback],[legacy,{...legacy}]),{today:'2026-12-25',days:2});
  const [before,after]=summary.rows;
  assert.deepEqual([before.activeMs,before.keys,before.phrases,before.captureCount],[1000,1,1,1]);
  assert.deepEqual([after.activeMs,after.keys,after.phrases,after.captureCount,after.practiceCount],[7000,7,2,0,1]);
  assert.equal(summary.totals.keys,8);assert.equal(summary.totals.activeMs,8000);assert.equal(summary.totals.estimated,true);
  assert.equal(summary.totals.capture.activeMs,2000,'the elapsed session window is not added over its attempts');
});

test('legacy source records are deduplicated and incomplete or orphan input still contributes observed practice',()=>{
  const orphan=attempt('orphan','unwritten',{source:'practice'}),manual=attempt('manual','manual-session');
  const summary=dailyTraining(data([session('manual-session',{source:'manual',durationMs:9999})],[orphan,{...orphan},manual,{...orphan,id:'demo',source:'demo'}]),{today:'2026-12-25',days:1});
  assert.deepEqual([summary.today.activeMs,summary.today.keys,summary.today.phrases,summary.today.practiceCount],[1000,5,1,1]);
  assert.equal(summary.today.captureCount,0);assert.equal(summary.today.estimated,true);
  const empty=dailyTraining(data([session('empty'),session('measured-empty',{activity:[]})]),{today:'2026-12-25'});
  assert.equal(empty.activeDays,0);assert.equal(empty.totals.captureCount,0);assert.equal(empty.totals.estimated,false);
});

test('empty legacy attempts do not create activity or fall back to a parent session estimate',()=>{
  const empty=attempt('empty','game',{durationMs:0,correctKeys:0,mistakes:0,typed:'',judgements:[]});
  const parent=session('game',{durationMs:90000,correctKeys:1000,mistakes:100,phraseCount:50});
  for(const sessions of [[],[parent]]){
    const summary=dailyTraining(data(sessions,[empty]),{today:'2026-12-25',days:2});
    assert.deepEqual([summary.totals.activeMs,summary.totals.keys,summary.totals.phrases,summary.totals.captureCount,summary.activeDays],[0,0,0,0,0]);
    assert.equal(summary.totals.estimated,false);
  }
});

test('legacy record counts start at the first nonempty attempt, including detailed keys without counters',()=>{
  const empty=attempt('empty','game',{startedAt:at('2026-12-24'),durationMs:0,correctKeys:0,mistakes:0,typed:'',judgements:[]});
  const keyed=attempt('keyed','game',{durationMs:0,correctKeys:0,mistakes:0,judgements:[{actual:'x',expected:['a'],accepted:false,position:0,at:now}]});
  const summary=dailyTraining(data([session('game')],[empty,keyed]),{today:'2026-12-25',days:2});
  assert.deepEqual([summary.rows[0].keys,summary.rows[0].phrases,summary.rows[0].captureCount],[0,0,0]);
  assert.deepEqual([summary.today.keys,summary.today.phrases,summary.today.captureCount,summary.activeDays],[1,1,1,1]);
});

test('historical ranges include leap days and never count a multi-day record again after its first activity day',()=>{
  const history=session('old',{activity:[{date:'2028-02-01',activeMs:100,keys:2,phrases:1},{date:'2028-02-29',activeMs:300,keys:4,phrases:2}]});
  const summary=dailyTraining(data([history]),{today:'2028-03-01',days:3});
  assert.deepEqual(summary.rows.map(row=>row.date),['2028-02-28','2028-02-29','2028-03-01']);
  assert.equal(summary.totals.keys,4);assert.equal(summary.totals.captureCount,0);assert.equal(summary.activeDays,1);
  assert.throws(()=>dailyTraining(data(),{today:'2026-02-30'}),RangeError);
  assert.throws(()=>dailyTraining(data(),{days:0}),RangeError);
});

test('activity snapshot merging is monotonic by date while retaining measured-empty and legacy distinction',()=>{
  assert.equal(mergeDailyActivity(undefined,undefined),undefined);assert.deepEqual(mergeDailyActivity([],undefined),[]);
  assert.deepEqual(mergeDailyActivity([{date:'2026-12-24',activeMs:1000,keys:10,phrases:2}],[{date:'2026-12-24',activeMs:500,keys:12,phrases:1},{date:'2026-12-25',activeMs:100,keys:2,phrases:1}]),[
    {date:'2026-12-24',activeMs:1000,keys:12,phrases:2},{date:'2026-12-25',activeMs:100,keys:2,phrases:1},
  ]);
});
