import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWords, buildAttempt, summarize } from '../src/core/analytics';
import { analyzeClauses } from '../src/core/clause-stats';
import { splitClauses, clauseTarget } from '../src/core/clauses';
import { createKanaTrace } from '../src/core/romaji';
import { DEFAULT_SETTINGS, type PracticePhrase } from '../src/core/types';

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

test('punctuation on the prompt can be silent or typed without hiding other clauses', () => {
  for (const suffix of ['', '。']) {
    const target = {...prompt,text:'犬と散歩に行く。',reading:'いぬとさんぽにいく'+suffix,roman:'inutosanponiiku'+(suffix ? '.' : '')};
    assert.deepEqual(splitClauses(target).slice(1), [
      {text:'散歩に',reading:'さんぽに',start:3}, {text:'行く。',reading:'いく'+suffix,start:7},
    ]);
    const attempts = [1,2].map(i=>record('inutox',i,{target,stopOnMiss:true}));
    assert.deepEqual(analyzeClauses(attempts,[target]).map(item=>item.clause.text), ['散歩に']);
  }
});

test('a clause-only practice day contributes to the streak and excludes full-prompt completions', t => {
  const at = Date.UTC(2026,10,24,1);
  t.mock.method(Date,'now',()=>at);
  const drill = record('kutiga',at/10000,{target:clauseTarget(prompt,middle)});
  const data = {attempts:[drill], phrases:[prompt], sessions:[], settings:DEFAULT_SETTINGS};
  const stats = summarize(data);
  assert.equal(stats.todayCount,0); assert.equal(stats.practiceCount,0); assert.equal(stats.streak,1);
  assert.equal(stats.accuracy,null); assert.equal(stats.kps,null);
  const full = record('x'+prompt.roman,at/10000,{gap:()=>200});
  const mixed = summarize({...data,attempts:[drill,full]});
  assert.equal(mixed.todayCount,1); assert.equal(mixed.practiceCount,1);
  assert.equal(mixed.accuracy,full.accuracy); assert.equal(mixed.kps,full.kps);
});
