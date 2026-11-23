import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConfusions, analyzePatterns, analyzeWords, buildAttempt, typingBaseline } from '../src/core/analytics';
import { createMatcher } from '../src/core/romaji';
import type { Attempt, Phrase, StrokeSample } from '../src/core/types';

const now=1760000000000;
const phrase=(id:string,reading:string,roman:string):Phrase=>({id,text:reading,reading,roman,source:'manual',confidence:100,verified:true,capturedAt:now,lastSeenAt:now,seenCount:1});
function typed(p:Phrase,keys:string,gap=100,start=now):Attempt{
  return buildAttempt({phrase:p,strokes:[...keys].map((key,i)=>({key,at:start+(i+1)*gap})),startedAt:start,endedAt:start+(keys.length+1)*gap,sessionId:'s1',source:'practice',complete:true,reliable:true});
}
function measured(id:string,phraseId:string,samples:StrokeSample[]):Attempt{
  return{id,phraseId,sessionId:'s1',source:'practice',startedAt:now,endedAt:now+10000,durationMs:10000,correctKeys:samples.length+1,mistakes:0,accuracy:100,kps:4,samples,complete:true,reliable:true,typed:'test'};
}
const sample=(pattern:string,intervalMs:number,i:number,error=false):StrokeSample=>({pattern,intervalMs,error,at:now+i*100});

test('valid next keys follow alternative roman paths and rejected keys do not change them',()=>{
  const matcher=createMatcher('しゃ','sya');
  assert.deepEqual(matcher.expectedKeys,['s','c']);
  matcher.feed('s');assert.deepEqual(matcher.expectedKeys,['y','h','i']);
  matcher.feed('q');assert.deepEqual(matcher.expectedKeys,['y','h','i']);
  assert.ok(matcher.feed('h').accepted);assert.deepEqual(matcher.expectedKeys,['a','i']);
  matcher.feed('a');assert.deepEqual(matcher.expectedKeys,[]);
  const nasal=createMatcher('んか','nka');nasal.feed('n');
  assert.ok(nasal.expectedKeys.includes('k'));assert.ok(nasal.expectedKeys.includes('n'));assert.ok(nasal.expectedKeys.includes("'"));
});

test('detailed judgements preserve actual errors, correct alternatives and exact positions',()=>{
  const result=typed(phrase('sh','しゃ','sya'),'Sqha');
  assert.equal(result.correctKeys,3);assert.equal(result.mistakes,1);assert.ok(result.reliable);
  assert.deepEqual(result.judgements?.map(k=>[k.actual,k.accepted,k.position]),[['S',true,0],['q',false,1],['h',true,1],['a',true,2]]);
  assert.deepEqual(result.judgements?.[1].expected,['y','h','i']);
  assert.equal(result.judgements?.[1].pattern,'sy');
  assert.equal(result.judgements?.[2].pattern,'sh');
  assert.equal(result.judgements?.[2].intervalMs,200);
  assert.equal(result.typed,'sha');
  const withSpace=typed(phrase('space','あい','ai'),'a i');
  assert.equal(withSpace.judgements?.[1].actual,' ');assert.equal(withSpace.judgements?.[1].accepted,false);
});

test('personal baseline is an arithmetic mean of clean adjacent intervals, without trigram duplication',()=>{
  const data=measured('a','p',[
    ...Array.from({length:20},(_,i)=>sample('ab',100,i)),
    ...Array.from({length:20},(_,i)=>sample('abc',900,i)),
    sample('bc',1800,21,true),sample('cd',2200,22),sample('de',5,23),
  ]);
  assert.deepEqual(typingBaseline([data]),{meanMs:100,kps:10,count:20});
  assert.deepEqual(typingBaseline([{...data,reliable:false}]),{meanMs:null,kps:null,count:0});
});

test('slow sequences compare clean means to the personal baseline and require repeated observations',()=>{
  const data=measured('a','p',[
    ...Array.from({length:24},(_,i)=>sample('ab',100,i)),
    ...Array.from({length:6},(_,i)=>sample('xy',300,i+24)),
    ...Array.from({length:3},(_,i)=>sample('xyz',500,i+30)),
    sample('xy',1800,34,true),
  ]);
  const patterns=analyzePatterns([data]);const slow=patterns.find(p=>p.pattern==='xy')!;
  assert.equal(slow.meanMs,300);assert.equal(slow.timedCount,6);assert.equal(slow.baselineMs,140);assert.equal(slow.baselineCount,30);
  assert.ok(slow.slow);assert.ok(Math.abs(slow.slowdownPct!-114.2857142857)<.0001);assert.equal(slow.lostMs,960);
  assert.equal(patterns.find(p=>p.pattern==='xyz')?.slow,false);
  assert.equal(patterns.find(p=>p.pattern==='ab')?.slow,false);
});

test('word-level mistakes and actual-to-expected confusions aggregate independently of clean speed',()=>{
  const p=phrase('mistakes','しゃ','sya');const attempts=Array.from({length:3},(_,i)=>typed(p,'sqha',100,now+i*1000));
  const words=analyzeWords(attempts,[p]);assert.equal(words.length,1);
  assert.equal(words[0].attempts,3);assert.equal(words[0].mistakes,3);assert.equal(words[0].correctKeys,9);assert.equal(words[0].errorRate,25);
  assert.equal(words[0].meanMs,100);assert.equal(words[0].timedCount,3);
  assert.deepEqual(words[0].confusions,[{actual:'q',expected:['y','h','i'],count:3}]);
  assert.deepEqual(analyzeConfusions([...attempts,{...attempts[0],reliable:false}]),words[0].confusions);
});

test('slow words expose their repeated slow sequences and exclude unrelated or incomplete records',()=>{
  const fast=phrase('fast','あい','ai'),slow=phrase('slow','いか','ika');
  const attempts=[...Array.from({length:24},(_,i)=>typed(fast,'ai',100,now+i*1000)),...Array.from({length:3},(_,i)=>typed(slow,'ika',300,now+(i+30)*1000))];
  const words=analyzeWords([...attempts,{...typed(slow,'ika',1900),complete:false}], [fast,slow]);
  const result=words.find(w=>w.phraseId==='slow')!;
  assert.equal(result.meanMs,300);assert.equal(result.attempts,3);assert.ok(result.slow);
  // Each individual bigram has only three observations, so it remains in measurement status.
  assert.deepEqual(result.slowPatterns,[]);
  assert.equal(words.find(w=>w.phraseId==='fast')?.slow,false);
  assert.deepEqual(analyzeWords(attempts,[]),[]);
});

test('legacy attempts without judgement arrays remain usable without inventing confusion history',()=>{
  const legacy=measured('legacy','p',[sample('ab',150,1)]);
  assert.equal(analyzeWords([legacy])[0].meanMs,150);
  assert.deepEqual(analyzeConfusions([legacy]),[]);
});

test('accuracy capture stops at the first miss and retains a bounded error and clean prefix',()=>{
  const p=phrase('terminal','ぺあるっく','pearukku');
  const result=buildAttempt({phrase:p,strokes:[...'peaqnextplate'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+5000,sessionId:'s1',source:'capture',complete:true,reliable:true,endOnMistake:true});
  assert.equal(result.errorTerminated,true);assert.equal(result.complete,false);assert.equal(result.reliable,true);
  assert.equal(result.correctKeys,3);assert.equal(result.mistakes,1);assert.equal(result.typed,'pea');
  assert.equal(result.endedAt,now+400);assert.equal(result.durationMs,400);assert.equal(result.kps,7.5);
  assert.equal(result.judgements?.map(k=>k.actual).join(''),'peaq');
  assert.deepEqual(result.judgements?.at(-1)?.expected,['r']);
  assert.deepEqual(result.samples.filter(s=>s.error).map(s=>[s.pattern,s.intervalMs]),[['ar',100],['ear',100]]);
  assert.ok(result.samples.every(s=>s.at<=now+400));
  assert.deepEqual(typingBaseline([result]),{meanMs:100,kps:10,count:2});
  const word=analyzeWords([result],[p])[0];
  assert.equal(word.attempts,1);assert.equal(word.mistakes,1);assert.equal(word.correctKeys,3);assert.equal(word.errorRate,25);assert.equal(word.meanMs,100);
  assert.deepEqual(word.confusions,[{actual:'q',expected:['r'],count:1}]);
  const patterns=analyzePatterns([result],[p]);
  assert.equal(patterns.find(s=>s.pattern==='ar')?.errors,1);
  assert.equal(patterns.find(s=>s.pattern==='ar')?.timedCount,0);
  assert.equal(patterns.find(s=>s.pattern==='ar')?.meanMs,null);
  assert.equal(patterns.find(s=>s.pattern==='ear')?.errors,1);
});

test('incomplete or unreliable captures cannot gain eligibility from a missing or contradictory terminal flag',()=>{
  const p=phrase('terminal','ぺあるっく','pearukku');
  const result=buildAttempt({phrase:p,strokes:[...'peaq'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+400,sessionId:'s1',source:'capture',complete:false,reliable:true,endOnMistake:true});
  const excluded:Attempt[]=[
    {...result,errorTerminated:undefined},
    {...result,reliable:false},
    {...result,judgements:undefined},
    {...result,source:'practice'},
    {...result,endedAt:now+500,durationMs:500},
    {...result,typed:'pear'},
  ];
  for(const attempt of excluded){
    assert.deepEqual(analyzeWords([attempt]),[]);assert.deepEqual(analyzeConfusions([attempt]),[]);assert.deepEqual(analyzePatterns([attempt]),[]);
    assert.deepEqual(typingBaseline([attempt]),{meanMs:null,kps:null,count:0});
  }
  const uncertain=buildAttempt({phrase:p,strokes:[{key:'q',at:now+100}],startedAt:now,endedAt:now+5000,sessionId:'s1',source:'capture',complete:false,reliable:false,endOnMistake:true});
  assert.equal(uncertain.errorTerminated,true);assert.equal(uncertain.reliable,false);
  assert.deepEqual(analyzeWords([uncertain]),[]);
});

test('terminal misses keep alternative expectations without guessing a pattern, and pauses do not become speed samples',()=>{
  const p=phrase('alternate','しゃ','sya');
  const result=buildAttempt({phrase:p,strokes:[...'sqha'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+2000,sessionId:'s1',source:'capture',complete:false,reliable:true,endOnMistake:true});
  assert.equal(result.typed,'s');assert.equal(result.mistakes,1);
  assert.deepEqual(result.judgements?.at(-1)?.expected,['y','h','i']);
  assert.deepEqual(analyzeConfusions([result]),[{actual:'q',expected:['y','h','i'],count:1}]);
  assert.deepEqual(analyzePatterns([result]),[]);
  const paused=buildAttempt({phrase:phrase('pause','ぺあるっく','pearukku'),strokes:[{key:'p',at:now+100},{key:'e',at:now+200},{key:'a',at:now+300},{key:'q',at:now+5000},{key:'r',at:now+5200}],startedAt:now,endedAt:now+6000,sessionId:'s1',source:'capture',complete:false,reliable:true,endOnMistake:true});
  assert.equal(paused.mistakes,1);assert.equal(paused.endedAt,now+5000);
  assert.equal(paused.samples.filter(s=>s.error).length,0);
  assert.deepEqual(typingBaseline([paused]),{meanMs:100,kps:10,count:2});
});

test('practice still accepts correction and completion even if a caller supplies the capture-only option',()=>{
  const p=phrase('practice','ぺあるっく','pearukku');
  const result=buildAttempt({phrase:p,strokes:[...'peaqrukku'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+1000,sessionId:'s1',source:'practice',complete:true,reliable:true,endOnMistake:true});
  assert.equal(result.errorTerminated,undefined);assert.equal(result.complete,true);assert.equal(result.reliable,true);
  assert.equal(result.typed,'pearukku');assert.equal(result.correctKeys,8);assert.equal(result.mistakes,1);
  assert.equal(result.endedAt,now+1000);assert.equal(result.durationMs,1000);
  assert.equal(result.samples.find(s=>s.pattern==='ar')?.intervalMs,200);
  assert.equal(result.samples.find(s=>s.pattern==='ar')?.error,true);
});
