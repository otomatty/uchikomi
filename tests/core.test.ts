import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatcher,kanaToRoman,normalizeRoman } from '../src/core/romaji';
import { analyzePatterns,buildAttempt,choosePractice,summarize } from '../src/core/analytics';
import { validateImport } from '../src/core/db';
import { DEFAULT_SETTINGS } from '../src/core/types';
import type { AppData,Attempt,Phrase } from '../src/core/types';
const now=Date.now();
function phrase(roman='pearukku',reading='ぺあるっく',id='p1'):Phrase{return {id,text:'ペアルック',reading,roman,source:'capture',confidence:94,verified:true,capturedAt:now,lastSeenAt:now,seenCount:1};}
function type(reading:string,roman:string,typed:string){const m=createMatcher(reading,roman);for(const key of typed)assert.equal(m.feed(key).accepted,true,`${reading}: ${typed} rejected ${key} after ${m.typed}`);assert.equal(m.complete,true,`${reading}: ${typed} incomplete; ${m.display}`);return m;}
const empty:AppData={phrases:[],attempts:[],sessions:[],settings:{...DEFAULT_SETTINGS}};
test('normalization handles full-width roman letters, case and curly apostrophe',()=>{assert.equal(normalizeRoman(' ＳＨＩ Ｎ’Ａ '),"shin'a");});
test('common romanization alternatives share one reading',()=>{
  for(const spelling of ['si','shi','ci'])type('し','shi',spelling);
  for(const spelling of ['ti','chi'])type('ち','chi',spelling);
  for(const spelling of ['tu','tsu'])type('つ','tsu',spelling);
  for(const spelling of ['sya','sha','sixya','shilya'])type('しゃ','sha',spelling);
});
test('gemination accepts doubled consonants and explicit small tsu',()=>{
  for(const spelling of ['pearukku','pearuxtuku','pearultuku','pearuxtsuku','pearultuku'])type('ペアルック','pearukku',spelling);
  for(const spelling of ['matcha','maccha','mattya','maxtucha'])type('まっちゃ','matcha',spelling);
});
test('nasal n disambiguates vowels/y and supports explicit variants',()=>{
  for(const spelling of ['kanpai','kannpai',"kan'pai",'kaxnpai'])type('かんぱい','kanpai',spelling);
  for(const spelling of ['kannai',"kan'ai"])type('かんあい','kannai',spelling);
  type('こんな','konna','konna');
  type('しんよう','sinnyou','sinnyou');
  const m=createMatcher('かんあい','kannai');for(const key of 'kan')m.feed(key);assert.equal(m.feed('a').accepted,false);
  type('ぱん','pann','pann');
});
test('a single nasal n cannot borrow the vowel branch of a following wu alternative',()=>{
  const matcher=createMatcher('んう','nnu');
  assert.equal(matcher.feed('n').accepted,true);
  assert.equal(matcher.feed('u').accepted,false);
  assert.equal(matcher.complete,false);assert.equal(matcher.typed,'n');
  assert.equal(matcher.feed('n').accepted,true);assert.equal(matcher.feed('u').complete,true);
  for(const spelling of ['nnu','nwu','nwhu',"n'u",'xnu'])type('んう','nnu',spelling);
  for(const spelling of ['nkka','nltuka','nxtuka'])type('んっか','nkka',spelling);
  const generated=kanaToRoman('んう');type('んう',generated,generated);
});
test('incorrect keys do not advance; display follows chosen spelling',()=>{
  const m=createMatcher('しつもん','shitsumonn');assert.equal(m.display,'shitsumonn');
  m.feed('s');assert.equal(m.feed('x').accepted,false);assert.equal(m.position,1);
  m.feed('i');assert.ok(m.display.startsWith('si'));for(const key of 'tumonn')m.feed(key);assert.equal(m.complete,true);assert.equal(m.typed,'situmonn');
  m.reset();assert.equal(m.position,0);assert.equal(m.display,'shitsumonn');
});
test('unsupported readings use exact roman fallback; punctuation and digits accepted',()=>{
  type('漢字を含む','typing123!','typing123!');
  type('３にん！','3nin!','3nin!');
  assert.equal(kanaToRoman('シュート'),'syu-to');assert.equal(kanaToRoman('漢字'),'');
});
test('attempt attribution counts correction without shifting later keys',()=>{
  const p=phrase('kakku','かっく');const strokes=[{key:'k',at:1100},{key:'a',at:1200},{key:'z',at:1250},{key:'k',at:1400},{key:'k',at:1550},{key:'u',at:1650}];
  const a=buildAttempt({phrase:p,strokes,startedAt:1000,endedAt:1650,sessionId:'s',source:'practice',complete:true,reliable:true});
  assert.equal(a.correctKeys,5);assert.equal(a.mistakes,1);assert.equal(a.typed,'kakku');assert.equal(a.reliable,true);
  assert.equal(a.samples.find(s=>s.pattern==='ak')?.error,true);assert.equal(a.samples.find(s=>s.pattern==='ak')?.intervalMs,200);
  assert.equal(a.samples.find(s=>s.pattern==='kk')?.error,false);
});
test('an accidental space is a mistype even though roman targets omit whitespace',()=>{
  const a=buildAttempt({phrase:phrase('ka','か'),strokes:[{key:'k',at:1100},{key:' ',at:1150},{key:'a',at:1250}],startedAt:1000,endedAt:1250,sessionId:'s',source:'practice',complete:true,reliable:true});
  assert.equal(a.mistakes,1);assert.equal(a.correctKeys,2);assert.equal(a.samples[0].error,true);
});
test('incomplete capture cannot be upgraded to reliable; held keys and pauses are excluded',()=>{
  const a=buildAttempt({phrase:phrase('kaku','かく'),strokes:[{key:'k',at:1100},{key:'k',at:1150,repeat:true},{key:'a',at:1200},{key:'k',at:4500}],startedAt:1000,endedAt:5000,sessionId:'s',source:'capture',complete:true,reliable:true});
  assert.equal(a.correctKeys,3);assert.equal(a.mistakes,0);assert.equal(a.complete,false);assert.equal(a.reliable,false);assert.equal(a.samples.filter(s=>s.pattern==='ak').length,0);
});
function synthetic(samples:Attempt['samples'],id='a'):Attempt{return {id,phraseId:'p1',sessionId:'s',source:'practice',startedAt:1000,endedAt:3000,durationMs:2000,correctKeys:10,mistakes:0,accuracy:100,kps:5,samples,complete:true,reliable:true,typed:'pearukku'};}
test('pattern analysis reports uncertainty, excludes unreliable data and shrinks rare errors',()=>{
  const sample=synthetic([{pattern:'kk',intervalMs:500,error:true,at:1300}]);assert.equal(analyzePatterns([sample])[0].confidence,'low');
  assert.deepEqual(analyzePatterns([{...sample,reliable:false}]),[]);
  assert.deepEqual(analyzePatterns([{...sample,complete:false}]),[]);
  assert.equal(analyzePatterns([sample,{...sample,id:'demo',source:'demo'}])[0].count,1);
});
test('pattern progress compares chronological windows and reports percent',()=>{
  const samples=Array.from({length:20},(_,i)=>({pattern:'kk',intervalMs:i<10?200:150,error:false,at:1000+i*200}));
  const stat=analyzePatterns([synthetic(samples)])[0];assert.equal(stat.confidence,'high');assert.equal(stat.previousMedianMs,200);assert.equal(stat.medianMs,150);assert.equal(stat.improvement,25);
});
test('practice only repeats saved verified phrases; filters requested combination',()=>{
  const words=[phrase(),{...phrase('sasimi','さしみ','p2'),text:'刺身'}, {...phrase('kakko','かっこ','p3'),verified:false}];
  const queue=choosePractice(words,[],10,'kk');assert.equal(queue.length,10);assert.ok(queue.every(p=>p.id==='p1'));
  assert.deepEqual(choosePractice(words,[],10,'zy'),[]);assert.deepEqual(choosePractice([],[],10),[]);
});
test('targeted practice prefers a valid actual spelling without changing the captured phrase',()=>{
  const p={...phrase('syasinn','しゃしん'),text:'写真'};
  const actual={...synthetic([{pattern:'sh',intervalMs:180,error:false,at:1500}]),typed:'shasinn',endedAt:3000};
  const invalidNewer={...actual,id:'invalid',typed:'shinvalid',endedAt:5000};
  const untrustedNewer={...actual,id:'uncertain',typed:"shasin'",reliable:false,endedAt:6000};
  const queue=choosePractice([p],[actual,invalidNewer,untrustedNewer],3,'sh');
  assert.equal(queue.length,3);assert.equal(queue[0].id,p.id);assert.equal(queue[0].roman,'shasinn');
  assert.ok(createMatcher(queue[0].reading,queue[0].roman).display.includes('sh'));
  assert.equal(p.roman,'syasinn');assert.equal(p.source,'capture');assert.notEqual(queue[0],p);
  assert.deepEqual(choosePractice([{...p,verified:false}],[actual],3,'sh'),[]);
});
test('targeted practice completes a trusted terminal-miss prefix without changing the captured word',()=>{
  const p={...phrase('syasinn','しゃしん'),text:'写真'};
  const terminal=buildAttempt({phrase:p,strokes:[...'shq'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+500,sessionId:'s',source:'capture',complete:false,reliable:true,endOnMistake:true});
  assert.equal(terminal.typed,'sh');assert.equal(terminal.errorTerminated,true);assert.equal(terminal.reliable,true);
  const queue=choosePractice([p],[terminal],5,'sh');
  assert.equal(queue.length,5);assert.ok(queue.every(word=>word.id===p.id&&word.roman.startsWith('sh')));
  type(queue[0].reading,queue[0].roman,queue[0].roman);
  assert.equal(p.roman,'syasinn');assert.equal(terminal.typed,'sh');
  for(const invalid of [{...terminal,errorTerminated:undefined},{...terminal,reliable:false},{...terminal,judgements:undefined}]){
    assert.deepEqual(choosePractice([p],[invalid],5,'sh'),[]);
  }
  const salt={...phrase('sio','しお','salt'),text:'塩'};
  const failedI=buildAttempt({phrase:salt,strokes:[...'shq'].map((key,i)=>({key,at:now+(i+1)*100})),startedAt:now,endedAt:now+500,sessionId:'s',source:'capture',complete:false,reliable:true,endOnMistake:true});
  assert.deepEqual(choosePractice([salt],[failedI],1,'hi').map(word=>word.roman),['shio']);
  assert.equal(salt.roman,'sio');
});
test('empty summary has no fabricated performance and aggregates only canonical total scores',()=>{
  assert.equal(summarize(empty).best,null);assert.equal(summarize(empty).accuracy,null);assert.equal(summarize(empty).practiceCount,0);
  const data:AppData={...empty,sessions:[{id:'s1',startedAt:now,source:'manual',score:18000,scoreType:'total',course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:0}, {id:'s2',startedAt:now+1,source:'manual',score:39000,scoreType:'total',course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:0}]};
  assert.equal(summarize(data).best,39000);assert.equal(summarize(data).median,28500);assert.equal(summarize(data).delta,10500);
  const unmigrated={...data.sessions[0],id:'old',score:999999,scoreType:'profit'} as unknown as AppData['sessions'][number];
  assert.equal(summarize({...data,sessions:[...data.sessions,unmigrated]}).best,39000);
});
test('practice accuracy and speed exclude capture measurements',()=>{
  const practice={...synthetic([]),correctKeys:8,mistakes:2,durationMs:2000};
  const capture={...synthetic([], 'capture'),source:'capture' as const,correctKeys:100,mistakes:0,durationMs:1000};
  const stats=summarize({...empty,attempts:[practice,capture]});
  assert.equal(stats.accuracy,80);assert.equal(stats.kps,4);assert.equal(stats.practiceCount,1);
});
test('backup validation rejects malformed nested data before any write',()=>{
  assert.deepEqual(validateImport({...empty,version:1}),empty);
  assert.throws(()=>validateImport({...empty,version:2}));
  assert.throws(()=>validateImport({...empty,version:1,phrases:[{...phrase(),screenshot:'https://malicious.test/image.png'}]}));
  assert.throws(()=>validateImport({...empty,version:1,settings:{...DEFAULT_SETTINGS,targetDate:'2026-02-31'}}));
  assert.throws(()=>validateImport({...empty,version:1,settings:{...DEFAULT_SETTINGS,targetScore:NaN}}));
  assert.throws(()=>validateImport({...empty,version:1,phrases:[phrase(),phrase()]}));
  assert.throws(()=>validateImport({...empty,version:1,phrases:[{...phrase(),roman:'漢字'}]}));
  assert.throws(()=>validateImport({...empty,version:1,phrases:[{...phrase(),source:'demo'}]}));
});
