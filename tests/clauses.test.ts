import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWords, buildAttempt } from '../src/core/analytics';
import { analyzeClauses } from '../src/core/clause-stats';
import { splitClauses, clauseTarget } from '../src/core/clauses';
import { createKanaTrace } from '../src/core/romaji';
import type { PracticePhrase } from '../src/core/types';

const prompt:PracticePhrase = {id:'prompt',text:'開いた口が塞がらない',reading:'あいたくちがふさがらない',
  roman:'aitakutigahusagaranai',verified:true,source:'capture',confidence:99,capturedAt:1,lastSeenAt:1,seenCount:1};
const middle = {text:'口が', reading:'くちが', start:3};
function record(keys:string, round:number, options:{target?:PracticePhrase; stopOnMiss?:boolean; gap?:(i:number)=>number} = {}) {
  const startedAt = round * 10000;
  let at = startedAt;
  const strokes = [...keys].map((key,i)=>({key,at:at += options.gap?.(i) ?? 80}));
  return buildAttempt({phrase:options.target ?? prompt,strokes,startedAt,endedAt:at,sessionId:'s',complete:true,
    reliable:true,source:options.stopOnMiss?'capture':'practice',endOnMistake:options.stopOnMiss});
}

test('aligns the three chunks to the saved reading, including alternate readings, and rejects ambiguous boundaries', () => {
  assert.deepEqual(splitClauses(prompt), [{text:'開いた',reading:'あいた',start:0}, middle, {text:'塞がらない',reading:'ふさがらない',start:6}]);
  assert.deepEqual(splitClauses({...prompt,reading:'ヒライタクチガフサガラナイ'})[1], {...middle,start:4});
  assert.deepEqual(splitClauses({...prompt,reading:''}), []);
  assert.deepEqual(splitClauses({...prompt,reading:'あいたて'}), []);
  // Either of the first two が could end the first chunk.
  assert.deepEqual(splitClauses({text:'猫が走る', reading:'ねこががはしる'}), []);
});

test('locates errors on the actual roman path, including terminal misses and the first key of the next chunk', () => {
  const terminal = record('aitakucx',1,{stopOnMiss:true});
  assert.ok(terminal.errorTerminated && terminal.reliable);
  const second = record('aitakutxigafusagaranai',2);
  const atBoundary = record('aitakuchigax',3,{stopOnMiss:true});
  const entries = analyzeClauses([terminal,second,atBoundary,{...atBoundary,reliable:false},
    {...atBoundary,judgements:undefined}], [prompt]);
  assert.deepEqual(entries.map(e=>[e.clause,e.mistakeAttempts]), [[middle,2]]);
  assert.deepEqual(analyzeClauses([terminal,second],[{...prompt,verified:false}]),[]);
  const afterBoundary = analyzeClauses([atBoundary,{...atBoundary,id:'another'}],[prompt]);
  assert.equal(afterBoundary[0].clause.text,'塞がらない');
});

test('only clean intervals within a chunk identify slow input; drills age out earlier misses without inflating whole-prompt stats', () => {
  const typed = 'aitakuchigafusagaranai';
  const samples = [1,2,3].map(i=>record(typed,i,{gap:j=>j>=5 && j<=10 ? 320 : 80}));
  const result = analyzeClauses(samples,[prompt]);
  assert.deepEqual(result.map(e=>e.clause),[middle]);
  assert.ok(result[0].slowdownPct! >= 20);
  const pauses = [1,2,3].map(i=>record(typed,i,{gap:j=>j===4 || j===11 ? 800 : 80}));
  assert.deepEqual(analyzeClauses(pauses,[prompt]),[]);
  const failures = [1,2].map(i=>record('aitax',i,{stopOnMiss:true}));
  const drills = Array.from({length:50},(_,i)=>record('kuchiga',i+3,{target:clauseTarget(prompt,middle)}));
  assert.deepEqual(analyzeClauses([...failures,...drills],[prompt]),[]);
  assert.equal(analyzeWords([...failures,...drills],[prompt])[0].attempts,2);
});

test('kana tracing follows contracted kana, geminates and nasal consonants across boundaries', () => {
  const trace = createKanaTrace('んっちゃ');
  const offsets = [...'ntcha'].map(key=>trace.step(key,true));
  assert.ok(trace.complete);
  assert.deepEqual(offsets,[[0],[1],[2],[2],[2]]);
  trace.reset();
  assert.deepEqual(trace.step('x',false),null); // xn is an accepted spelling of ん
  assert.deepEqual(trace.step('z',false),[0]);
});

test('a repeated clause counts once per attempt and combines with evidence from another prompt', () => {
  const repeated = {...prompt, id:'repeated', text:'口が開いた口が塞がらない', reading:'くちがあいたくちがふさがらない',
    roman:'kutigaaitakutigahusagaranai'};
  const first = record('xkutigaaitaxkutigahusagaranai',1,{target:repeated});
  assert.ok(first.complete && first.mistakes===2);
  assert.deepEqual(analyzeClauses([first],[repeated]),[]);
  const second = record('aitax',2,{stopOnMiss:true});
  const [weak] = analyzeClauses([second,first],[prompt,repeated]);
  assert.equal(weak.phrase.id,prompt.id);
  assert.deepEqual(weak.clause,middle);
  assert.equal(weak.mistakeAttempts,2);
});
