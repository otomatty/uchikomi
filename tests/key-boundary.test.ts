import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionBoundary, replayCapturedPhrase } from '../src/capture/key-boundary';
import type { CapturedReplay } from '../src/capture/key-boundary';
import type { Phrase } from '../src/core/types';
import { analyzeWords, typingBaseline } from '../src/core/analytics';

const now=1760000000000;
const phrase:Phrase={id:'ika',text:'いか',reading:'いか',roman:'ika',source:'capture',confidence:100,verified:true,capturedAt:now,lastSeenAt:now,seenCount:1};
const key=(value:string,at:number)=>({key:value,at:now+at});
const input=(patch:Partial<CapturedReplay>={}):CapturedReplay=>({
  phrase,strokes:[key('u',150),key('i',175),key('k',250),key('a',300),key('q',400)],
  observedAt:now+200,endedAt:now+350,sessionId:'recording',contiguous:true,
  precedingCompletion:now+150,observationReliable:true,focusGaps:[],accuracyMode:true,...patch,
});

test('a completed predecessor recovers the first key before the changed frame and excludes the predecessor key',()=>{
  const replay=replayCapturedPhrase(input());
  assert.equal(replay.anchored,true);assert.equal(replay.completionAt,now+300);
  const attempt=replay.attempt!;
  assert.equal(attempt.startedAt,now+150);assert.equal(attempt.typed,'ika');
  assert.equal(attempt.complete,true);assert.equal(attempt.reliable,true);
  assert.equal(attempt.correctKeys,3);assert.equal(attempt.mistakes,0);
  assert.deepEqual(attempt.judgements?.map(k=>[k.actual,k.at]),[['i',now+175],['k',now+250],['a',now+300]]);
  assert.deepEqual(typingBaseline([attempt]),{meanMs:62.5,kps:16,count:2});
});

test('a missing-prefix rejection without a completion anchor remains excluded from mistakes',()=>{
  const replay=replayCapturedPhrase(input({precedingCompletion:null}));
  assert.equal(replay.anchored,false);assert.equal(replay.completionAt,null);
  const attempt=replay.attempt!;
  assert.equal(attempt.errorTerminated,true);assert.equal(attempt.reliable,false);
  assert.equal(attempt.endedAt,now+250);assert.equal(attempt.correctKeys,0);assert.equal(attempt.mistakes,1);
  assert.deepEqual(attempt.judgements?.map(k=>[k.actual,k.expected]),[['k',['i','y']]]);
  assert.deepEqual(analyzeWords([attempt]),[]);
});

test('a genuine first mistype after a verified completion ends at that key and discards all next-plate input',()=>{
  const replay=replayCapturedPhrase(input({strokes:[key('u',150),key('q',175),key('i',250),key('k',275),key('a',300)]}));
  assert.equal(replay.anchored,true);assert.equal(replay.completionAt,null);
  const attempt=replay.attempt!;
  assert.equal(attempt.errorTerminated,true);assert.equal(attempt.complete,false);assert.equal(attempt.reliable,true);
  assert.equal(attempt.endedAt,now+175);assert.equal(attempt.durationMs,25);
  assert.equal(attempt.correctKeys,0);assert.equal(attempt.mistakes,1);
  assert.equal(attempt.judgements?.map(k=>k.actual).join(''),'q');
  assert.equal(analyzeWords([attempt])[0].mistakes,1);
  assert.deepEqual(typingBaseline([attempt]),{meanMs:null,kps:null,count:0});
});

test('a first or reacquired complete phrase can establish its end without trusting its own uncertain start',()=>{
  const replay=replayCapturedPhrase(input({contiguous:false,strokes:[key('i',225),key('k',250),key('a',300)]}));
  assert.equal(replay.anchored,false);assert.equal(replay.completionAt,now+300);
  assert.equal(replay.attempt?.complete,true);assert.equal(replay.attempt?.reliable,false);
  assert.equal(replay.attempt?.startedAt,now+200);
});

test('errors, partial input, uncertain OCR, focus gaps, unordered keys and no input cannot establish the next boundary',()=>{
  const clean=[key('i',225),key('k',250),key('a',300)];
  const cases:Partial<CapturedReplay>[]=[
    {strokes:[key('i',225),key('q',250),key('k',275),key('a',300)]},
    {strokes:clean.slice(0,-1)},
    {strokes:clean,observationReliable:false},
    {strokes:clean,phrase:{...phrase,verified:false}},
    {strokes:clean,focusGaps:[now+275]},
    {strokes:[key('i',250),key('k',225),key('a',300)]},
    {strokes:[]},
  ];
  for(const patch of cases)assert.equal(replayCapturedPhrase(input(patch)).completionAt,null);
  assert.equal(replayCapturedPhrase(input({strokes:[]})).attempt,null);
});

test('stale, future, or noncontiguous completion timestamps cannot anchor a terminal miss',()=>{
  for(const patch of [
    {precedingCompletion:now-301},
    {precedingCompletion:now+201},
    {precedingCompletion:NaN},
    {contiguous:false},
  ]){
    const replay=replayCapturedPhrase(input({...patch,strokes:[key('q',225),key('i',250),key('k',275),key('a',300)]}));
    assert.equal(replay.anchored,false);assert.equal(replay.completionAt,null);
    assert.equal(replay.attempt?.errorTerminated,true);assert.equal(replay.attempt?.reliable,false);
  }
});

test('completion handoffs resolve once, including invalid boundaries, without waiting on another handoff',{timeout:1000},async()=>{
  const complete=createCompletionBoundary(),missing=createCompletionBoundary(),invalid=createCompletionBoundary(),infinite=createCompletionBoundary();
  complete.settle(now+150);complete.settle(now+300);complete.settle(null);
  missing.settle(null);missing.settle(now+400);
  invalid.settle(NaN);invalid.settle(now+500);
  infinite.settle(Infinity);
  assert.deepEqual(await Promise.all([complete.promise,missing.promise,invalid.promise,infinite.promise]),[now+150,null,null,null]);
});
