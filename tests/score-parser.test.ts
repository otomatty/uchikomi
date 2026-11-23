import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResultScore, StableScoreReader, type ScoreText, type ParsedScore } from '../src/capture/score-parser';

const labelled=(patch:Partial<ScoreText>={}):ScoreText=>({
  headerText:'高級10,000円コース【正確重視】',
  bodyText:'29,740円分のお寿司をゲット！10,000円払って…19,740円分お得でした！',
  headerConfidence:94,bodyConfidence:94,...patch,
});
const numeric=(patch:Partial<ScoreText>={}):ScoreText=>({
  headerText:'',bodyText:'数字を含む本文の認識が不完全',headerConfidence:0,bodyConfidence:25,
  labelText:'19,740内分お得でした！',labelConfidence:94,structureConfidence:.96,
  numeric:{total:{text:'29,740',confidence:95},paid:{text:'10,000',confidence:96},profit:{text:'19,740',confidence:96}},
  ...patch,
});
function notSaved(input:ScoreText,message?:string){assert.notEqual(parseResultScore(input).kind,'score',message);}

test('the directly observed food total is the only score, including stale mode input',()=>{
  for(const input of [labelled(),{...labelled(),scoreType:'profit'} as ScoreText]){
    const result=parseResultScore(input);assert.equal(result.kind,'score');assert.equal(result.score,29740);
    assert.equal(result.total,29740);assert.equal(result.scoreType,'total');assert.equal(result.modeSource,'ocr');
    assert.equal(Object.hasOwn(result,'profit'),false);
  }
  const wide=parseResultScore(labelled({bodyText:'２９，７４０ 円 分 の お 寿司 を ゲット！\n１０，０００ 円 払って\n１９，７４０ 円 分 お得 でした！'}));
  assert.equal(wide.kind,'score');assert.equal(wide.score,29740);
});

test('independent numeric crops return the total when Japanese digit OCR is incomplete',()=>{
  const result=parseResultScore(numeric());assert.equal(result.kind,'score');assert.equal(result.score,29740);assert.equal(result.modeSource,'configured');
  assert.equal(parseResultScore(numeric({headerText:'高級10,000円コース【正確重視】',headerConfidence:94})).modeSource,'ocr');
  assert.equal(parseResultScore(numeric({labelText:'内分ね得でした！',labelConfidence:88})).score,29740);
  const dots=parseResultScore(numeric({numeric:{total:{text:'29.740',confidence:95},paid:{text:'10.000',confidence:96},profit:{text:'19.740',confidence:96}}}));
  assert.equal(dots.kind,'score');assert.equal(dots.score,29740);
});

test('clear total and payment remain usable when the optional difference cannot be read',()=>{
  const observed=numeric({totalLabelText:'円分のお寿司をゲット！',totalLabelConfidence:94,labelText:'',labelConfidence:0,
    numeric:{total:{text:'29,740',confidence:95},paid:{text:'10,000',confidence:96}}});
  assert.equal(parseResultScore(observed).score,29740);
  assert.equal(parseResultScore({...observed,totalLabelText:'円分のお禾弘をゲット！',totalLabelConfidence:84}).score,29740,'the actual reference total label remains sufficient without the auxiliary row');
  assert.equal(parseResultScore({...observed,numeric:{...observed.numeric,profit:{text:'???',confidence:99}}}).score,29740);
  assert.equal(parseResultScore({...observed,numeric:{...observed.numeric,profit:{text:'19,760',confidence:40}}}).score,29740);
  const bodyOnly=labelled({bodyConfidence:25,amountLines:{
    total:{text:'29,740円分のお寿司をゲット！',confidence:94},paid:{text:'10,000円払って…',confidence:93},
    profit:{text:'19,760円分お得でした！',confidence:25},
  }});
  assert.equal(parseResultScore(bodyOnly).score,29740,'weak auxiliary OCR must not lower clear primary lines');
  assert.equal(parseResultScore(labelled({bodyText:'29,740円分のお寿司をゲット！10,000円払って…'})).score,29740);
});

test('every accepted total label also contributes its amount to independent OCR agreement',()=>{
  for(const suffix of ['円分のお禾弘をゲット！','内分のお禾弘を獲得！','円分のお寿司をゲット！']){
    const input=numeric({totalLabelText:suffix,totalLabelConfidence:94,labelText:'',labelConfidence:0,
      amountLines:{total:{text:`29,760${suffix}`,confidence:94},paid:{text:'10,000円払って…',confidence:94},profit:{text:'',confidence:0}},
      numeric:{total:{text:'29,740',confidence:95},paid:{text:'10,000',confidence:95}}});
    const parsed=parseResultScore(input);assert.equal(parsed.kind,'review',suffix);
    const stable=new StableScoreReader();assert.equal(stable.observe(parsed,1000),null);
    assert.equal(stable.observe(parseResultScore(input),1600)?.kind,'review','a repeated digit misread must remain a review');
    const agreeing={...input,amountLines:{...input.amountLines,total:{text:`29,740${suffix}`,confidence:94}}};
    assert.equal(parseResultScore(agreeing).score,29740,'an unreadable optional row does not block agreement');
  }
});

test('total and payment can independently use labelled rows or structured numeric crops',()=>{
  const input=numeric({totalLabelText:'円分のお寿司をゲット！',totalLabelConfidence:94,
    amountLines:{total:{text:'29,740円分のお寿司をゲット！',confidence:93},paid:{text:'10,000円払つて…',confidence:94},profit:{text:'19,740円分お得でした！',confidence:94}},
    numeric:{paid:{text:'10,000',confidence:96},profit:{text:'19,740',confidence:96}}});
  const result=parseResultScore(input);assert.equal(result.kind,'score');assert.equal(result.score,29740);assert.equal(result.confidence,93);
  const inverse={...input,amountLines:{...input.amountLines,total:{text:'合計数字は不明',confidence:20},paid:{text:'10,000円払って…',confidence:92}},
    numeric:{total:{text:'29,740',confidence:95}}};
  assert.equal(parseResultScore(inverse).kind,'score');assert.equal(parseResultScore(inverse).confidence,92);
  notSaved({...input,structureConfidence:.89},'a mixed numeric payment still requires a verified receipt structure');
  notSaved({...input,numeric:{paid:{text:'10,000',confidence:84}}},'a mixed numeric payment still requires numeric confidence');
  notSaved({...input,numeric:{paid:{text:'5,000',confidence:96}}},'the independently selected payment must be 10,000 yen');
});

test('the difference row supplies its own trusted gain/loss evidence even when its label crop is empty or weak',()=>{
  const input=numeric({totalLabelText:'円分のお寿司をゲット！',totalLabelConfidence:94,
    labelText:'',labelConfidence:0,amountLines:{profit:{text:'円分損でした！',confidence:94}},
    numeric:{total:{text:'29,740',confidence:95},paid:{text:'10,000',confidence:96}}});
  notSaved(input,'a clearly read loss contradicts a total above the course cost');
  notSaved({...input,labelText:'円分お得でした！',labelConfidence:40},'a weak crop cannot hide the confident full-row loss');
  notSaved({...input,labelText:'円分お得でした！',labelConfidence:94},'conflicting reliable directions must be reviewed');
  assert.equal(parseResultScore({...input,amountLines:{profit:{text:'円分損でした！',confidence:40}}}).score,29740,'weak optional evidence remains optional');
  notSaved({...input,amountLines:{profit:{text:'円分お得でした！',confidence:94}},numeric:{total:{text:'9,200',confidence:95},paid:{text:'10,000',confidence:96}}},'gain also contradicts a total below the course cost');
});

test('totals below the course cost, break-even totals and zero remain nonnegative food amounts',()=>{
  const belowCost=parseResultScore(labelled({bodyText:'9,200円分のお寿司をゲット！10,000円払って800円分損でした！'}));
  assert.equal(belowCost.kind,'score');assert.equal(belowCost.score,9200);
  const observed=parseResultScore(numeric({labelText:'800円分損でした！',numeric:{total:{text:'9,200',confidence:95},paid:{text:'10,000',confidence:96},profit:{text:'800',confidence:96}}}));
  assert.equal(observed.score,9200);assert.equal(Object.hasOwn(observed,'profit'),false);
  assert.equal(parseResultScore(labelled({bodyText:'10,000円分のお寿司をゲット！10,000円払って0円分お得でした！'})).score,10000);
  assert.equal(parseResultScore(labelled({bodyText:'0円分のお寿司をゲット！10,000円払って10,000円分損でした！'})).score,0);
});

test('a missing total is never reconstructed from the difference and course cost',()=>{
  notSaved(numeric({numeric:{paid:{text:'10,000',confidence:96},profit:{text:'19,740',confidence:96}}}));
  notSaved(labelled({bodyText:'10,000円払って19,740円分お得でした！'}));
  notSaved(numeric({numeric:{total:{text:'29,740',confidence:96}}}),'missing payment');
  notSaved(labelled({bodyText:'29,740円分のお寿司をゲット！19,740円分お得でした！'}),'missing labelled payment');
});

test('ranking text and unlabeled numbers never become result scores',()=>{
  for(const bodyText of ['スコア30,000円ランキング1位','30,000円','1位 29,740 10,000 19,740','正しく打ったキー1541平均7.9ミスタイプ6'])assert.equal(parseResultScore(labelled({bodyText})).kind,'none');
  notSaved(numeric({labelText:'ランキングスコア19,740円'}));notSaved(numeric({labelText:'19,740円'}));
});

test('ambiguous characters, malformed separators and signs cannot supply a primary total',()=>{
  for(const text of ['29,7O0','I9,740','29,74','29.74','29..740','29,740.000','+29740','-29740','1e4','','1,000,020']){
    const input=numeric();input.numeric!.total={text,confidence:99};notSaved(input,text);
  }
  for(const token of ['29,7O0','29,74','29.74','29..740','+29740','-29740'])notSaved(labelled({bodyText:`${token}円分のお寿司をゲット！10,000円払って19,740円分お得でした！`}),token);
});

test('confident contradictory amounts require review, but unreadable auxiliary text does not',()=>{
  const wrongTotal=numeric();wrongTotal.numeric!.total={text:'29,760',confidence:99};notSaved(wrongTotal);
  const contradictory='29,760円分のお寿司をゲット！10,000円払って19,760円分お得でした！';
  notSaved(numeric({bodyText:contradictory,bodyConfidence:94}));
  assert.equal(parseResultScore(numeric({bodyText:contradictory,bodyConfidence:25})).score,29740);
  notSaved(numeric({labelText:'19,740円分お得でした！800円分損でした！'}));
  notSaved(numeric({labelText:'円分損でした！',numeric:{total:{text:'29,740',confidence:95},paid:{text:'10,000',confidence:96}}}),'a confident contradictory direction remains evidence even if the auxiliary digits are unreadable');
  notSaved(labelled({bodyText:'29,740円分のお寿司をゲット！30,000円分のお寿司をゲット！10,000円払って19,740円分お得でした！'}));
  notSaved(labelled({bodyText:'29,740円分のお寿司をゲット！5,000円払って19,740円分お得でした！'}));
  notSaved(labelled({bodyText:'29,741円分のお寿司をゲット！10,000円払って…'}),'unreachable 20-yen increment');
  assert.equal(parseResultScore(labelled({bodyText:'29,740円分のお寿司をゲット！10,000円払って19,7O0円分お得でした！'})).score,29740);
});

test('an explicitly different course or mode blocks automatic saving',()=>{
  for(const headerText of ['お勧め5,000円コース【正確重視】','高級10,000円コース【普通】','高級10,000円コース【ふつう】','高級10,000円コース【速度必須】','高級10,000円コース【一発勝負】']){
    notSaved(numeric({headerText,headerConfidence:99}),headerText);notSaved(labelled({headerText,headerConfidence:99}),headerText);
  }
});

test('structure, semantic-label and primary numeric confidence gates remain independent',()=>{
  for(const structureConfidence of [.89,NaN])notSaved(numeric({structureConfidence}));
  for(const labelConfidence of [81,NaN])notSaved(numeric({labelConfidence}));
  for(const kind of ['total','paid'] as const){const input=numeric();input.numeric![kind]!.confidence=84;notSaved(input,kind);}
  const auxiliary=numeric();auxiliary.numeric!.profit!.confidence=84;assert.equal(parseResultScore(auxiliary).kind,'score');
  notSaved(labelled({bodyConfidence:NaN}));
  const boundary=numeric({labelConfidence:82,structureConfidence:.9});for(const item of Object.values(boundary.numeric!))item!.confidence=85;
  assert.equal(parseResultScore(boundary).kind,'score');
});

test('a confident isolated label cannot promote weak body-text amounts',()=>{
  const input=labelled({labelText:'19,740円分お得でした！',labelConfidence:94,bodyConfidence:40});
  const result=parseResultScore(input);assert.equal(result.kind,'review');assert.equal(result.confidence,40);
  for(const bodyConfidence of [81,NaN])notSaved({...input,bodyConfidence});
  assert.equal(parseResultScore({...input,bodyConfidence:82}).kind,'score');assert.equal(parseResultScore(numeric({bodyConfidence:25})).kind,'score');
});

test('body-text fallback rejects usable contradictory numeric crops without requiring them',()=>{
  const input=labelled({labelText:'19,740円分お得でした！',labelConfidence:94,structureConfidence:.89});
  for(const observed of [{total:{text:'29,760',confidence:95}},{paid:{text:'5,000',confidence:95}},{profit:{text:'19,760',confidence:95}}])assert.equal(parseResultScore({...input,numeric:observed}).kind,'review');
  assert.equal(parseResultScore(input).kind,'score');assert.equal(parseResultScore({...input,numeric:numeric().numeric}).kind,'score');
  assert.equal(parseResultScore({...input,numeric:{total:{text:'29,760',confidence:84}}}).kind,'score');
});

test('two separate agreeing observations save 29,740, never the displayed difference',()=>{
  const reader=new StableScoreReader(),score=parseResultScore(labelled());
  assert.equal(reader.observe(score,1000),null);assert.equal(reader.observe(score,1000),null);assert.equal(reader.observe(score,1300),null);
  const result=reader.observe({...score,confidence:88},1500);
  assert.equal(result?.kind,'score');assert.equal(result?.score,29740);assert.equal(result?.scoreType,'total');assert.equal(result?.confidence,88);assert.equal(Object.hasOwn(result!,'profit'),false);
});

test('score changes, blank intervals and long gaps reset stability; optional absent differences do not',()=>{
  const first=parseResultScore(labelled()),second=parseResultScore(labelled({bodyText:'30,000円分のお寿司をゲット！10,000円払って20,000円分お得でした！'}));
  const reader=new StableScoreReader();assert.equal(reader.observe(first,1000),null);assert.equal(reader.observe(second,1600),null);assert.equal(reader.observe(second,2200)?.score,30000);
  assert.equal(reader.observe({kind:'none',scoreType:'total',confidence:0},3400),null);assert.equal(reader.observe(first,4000),null);assert.equal(reader.observe(first,17000),null);
  const withoutDifference=parseResultScore(labelled({bodyText:'29,740円分のお寿司をゲット！10,000円払って…'}));assert.equal(reader.observe(withoutDifference,17600)?.score,29740);
});

test('legacy score observations and low-confidence frames cannot establish a saved total',()=>{
  const reader=new StableScoreReader(),high=parseResultScore(labelled()),low:ParsedScore={...high,kind:'review',confidence:40,reason:'uncertain'};
  assert.equal(reader.observe(low,1000),null);assert.equal(reader.observe(high,1600)?.kind,'review');assert.equal(reader.observe(high,2200)?.kind,'score');
  assert.equal(reader.observe({...high,scoreType:'profit',score:19740} as unknown as ParsedScore,2800),null);
  assert.equal(reader.observe(high,3400),null,'legacy observations clear prior agreement');assert.equal(reader.observe(high,NaN),null);
});

test('review reasons describe amount validation without offering another score basis',()=>{
  for(const input of [numeric({labelText:'19,740円分お得でした！800円分損でした！'}),numeric({numeric:{total:{text:'29,760',confidence:95},paid:{text:'10,000',confidence:95},profit:{text:'19,740',confidence:95}}})]){
    const result=parseResultScore(input);assert.equal(result.kind,'review');assert.equal(result.scoreType,'total');assert.doesNotMatch(result.reason??'',/お得|損/);
  }
});
