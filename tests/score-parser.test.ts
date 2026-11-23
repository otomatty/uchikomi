import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResultScore, StableScoreReader, type ScoreText, type ParsedScore } from '../src/capture/score-parser';

const labelled=(patch:Partial<ScoreText>={}):ScoreText=>({
  headerText:'高級10,000円コース【正確重視】',
  bodyText:'29,740円分のお寿司をゲット！10,000円払って…19,740円分お得でした！',
  headerConfidence:94,bodyConfidence:94,scoreType:'profit',...patch,
});
const numeric=(patch:Partial<ScoreText>={}):ScoreText=>({
  headerText:'',bodyText:'数字を含む本文の認識が不完全',headerConfidence:0,bodyConfidence:25,scoreType:'profit',
  labelText:'19,740内分お得でした！',labelConfidence:94,structureConfidence:.96,
  numeric:{total:{text:'29,740',confidence:95},paid:{text:'10,000',confidence:96},profit:{text:'19,740',confidence:96}},
  ...patch,
});
function notSaved(input:ScoreText,message?:string){assert.notEqual(parseResultScore(input).kind,'score',message);}

test('labelled results distinguish profit from total and normalize typography without guessing digits',()=>{
  const profit=parseResultScore(labelled());assert.equal(profit.kind,'score');assert.equal(profit.score,19740);
  assert.equal(profit.total,29740);assert.equal(profit.profit,19740);assert.equal(profit.modeSource,'ocr');
  const total=parseResultScore(labelled({scoreType:'total'}));assert.equal(total.kind,'score');assert.equal(total.score,29740);
  assert.notEqual(profit.fingerprint,total.fingerprint,'different score bases cannot stabilize each other');
  const wide=parseResultScore(labelled({bodyText:'２９，７４０ 円 分 の お 寿司 を ゲット！\n１０，０００ 円 払って\n１９，７４０ 円 分 お得 でした！'}));
  assert.equal(wide.kind,'score');assert.equal(wide.score,19740);
});

test('observed numeric crops corroborate amounts when Japanese digit OCR is incomplete',()=>{
  const result=parseResultScore(numeric());assert.equal(result.kind,'score');assert.equal(result.score,19740);
  assert.equal(result.modeSource,'configured','an unreadable mode is not presented as OCR verified');
  const observedMode=parseResultScore(numeric({headerText:'高級10,000円コース【正確重視】',headerConfidence:94}));
  assert.equal(observedMode.modeSource,'ocr');
  const observedLabel=parseResultScore(numeric({labelText:'内分ね得でした！',labelConfidence:88}));
  assert.equal(observedLabel.kind,'score');assert.equal(observedLabel.score,19740);
  notSaved(labelled({bodyText:'10,000円払って19,740内分ね得でした！'}),'OCR label variations alone do not supply trustworthy numeric evidence');
  const dots=parseResultScore(numeric({numeric:{total:{text:'29.740',confidence:95},paid:{text:'10.000',confidence:96},profit:{text:'19.740',confidence:96}}}));
  assert.equal(dots.kind,'score');assert.equal(dots.score,19740);
});

test('loss and break-even retain their signs in both amount-reading paths',()=>{
  const loss=parseResultScore(labelled({bodyText:'9,200円分のお寿司をゲット！10,000円払って800円分損でした！'}));
  assert.equal(loss.kind,'score');assert.equal(loss.score,-800);assert.equal(loss.total,9200);
  const observedLoss=parseResultScore(numeric({labelText:'800円分損でした！',numeric:{total:{text:'9,200',confidence:95},paid:{text:'10,000',confidence:96},profit:{text:'800',confidence:96}}}));
  assert.equal(observedLoss.kind,'score');assert.equal(observedLoss.score,-800);
  const zero=parseResultScore(labelled({bodyText:'10,000円分のお寿司をゲット！10,000円払って0円分お得でした！'}));
  assert.equal(zero.kind,'score');assert.equal(zero.score,0);
});

test('a missing total can be derived only from an observed amount and the corroborated payment',()=>{
  const result=parseResultScore(numeric({numeric:{paid:{text:'10,000',confidence:96},profit:{text:'19,740',confidence:96}}}));
  assert.equal(result.kind,'score');assert.equal(result.total,29740);
  notSaved(numeric({numeric:{profit:{text:'19,740',confidence:96}}}),'missing payment');
  notSaved(numeric({numeric:{paid:{text:'5,000',confidence:96},profit:{text:'19,740',confidence:96}}}),'wrong payment');
  notSaved(labelled({bodyText:'29,740円分のお寿司をゲット！19,740円分お得でした！'}),'missing labelled payment');
});

test('ranking text and unlabeled numbers never become result scores',()=>{
  for(const bodyText of ['スコア30,000円ランキング1位','30,000円','1位 29,740 10,000 19,740','正しく打ったキー1541平均7.9ミスタイプ6']){
    assert.equal(parseResultScore(labelled({bodyText})).kind,'none');
  }
  notSaved(numeric({labelText:'ランキングスコア19,740円'}));
  notSaved(numeric({labelText:'19,740円'}));
});

test('numeric OCR does not turn ambiguous characters, malformed separators or signs into money',()=>{
  for(const text of ['19,7O0','I9,740','19,74','19.74','19..740','19,740.000','+19740','-19740','1e4','','1,000,020']){
    const input=numeric();input.numeric!.profit={text,confidence:99};
    notSaved(input,`corrupted numeric crop: ${text}`);
  }
  for(const token of ['19,7O0','19,74','19.74','19..740','+19740','-19740'])notSaved(labelled({bodyText:`29,740円分のお寿司をゲット！10,000円払って${token}円分お得でした！`}),`corrupted labelled number: ${token}`);
});

test('contradictory totals, payment, signs, or independent OCR readings require review',()=>{
  const wrongTotal=numeric();wrongTotal.numeric!.total={text:'29,760',confidence:99};notSaved(wrongTotal);
  notSaved(numeric({bodyText:'29,760円分のお寿司をゲット！10,000円払って19,760円分お得でした！'}));
  notSaved(numeric({labelText:'19,740円分お得でした！800円分損でした！'}));
  notSaved(labelled({bodyText:'29,740円分のお寿司をゲット！30,000円分のお寿司をゲット！10,000円払って19,740円分お得でした！'}));
  notSaved(labelled({bodyText:'29,740円分のお寿司をゲット！5,000円払って19,740円分お得でした！'}));
  notSaved(labelled({bodyText:'29,741円分のお寿司をゲット！10,000円払って19,741円分お得でした！'}),'not reachable with 20-yen price increments');
  notSaved(numeric({labelText:'10,020円分損でした！',numeric:{paid:{text:'10,000',confidence:96},profit:{text:'10,020',confidence:96}}}),'loss cannot imply a negative food total');
});

test('an explicitly different course or mode blocks automatic saving',()=>{
  for(const headerText of ['お勧め5,000円コース【正確重視】','高級10,000円コース【普通】','高級10,000円コース【ふつう】','高級10,000円コース【速度必須】','高級10,000円コース【一発勝負】']){
    notSaved(numeric({headerText,headerConfidence:99}),headerText);
    notSaved(labelled({headerText,headerConfidence:99}),headerText);
  }
});

test('structure, label and individual numeric confidence gates are independent',()=>{
  notSaved(numeric({structureConfidence:.89}));
  notSaved(numeric({structureConfidence:NaN}));
  notSaved(numeric({labelConfidence:81}));
  notSaved(numeric({labelConfidence:NaN}));
  for(const kind of ['total','paid','profit'] as const){const input=numeric();input.numeric![kind]!.confidence=84;notSaved(input,kind);}
  notSaved(labelled({bodyConfidence:NaN}));
  const boundary=numeric({labelConfidence:82,structureConfidence:.9});
  for(const item of Object.values(boundary.numeric!))item!.confidence=85;
  assert.equal(parseResultScore(boundary).kind,'score');
});

test('two genuinely separate agreeing result observations are required',()=>{
  const reader=new StableScoreReader(),score=parseResultScore(labelled());
  assert.equal(reader.observe(score,1000),null);
  assert.equal(reader.observe(score,1000),null,'same callback time is not independent evidence');
  assert.equal(reader.observe(score,1300),null,'too close to the initial observation');
  const result=reader.observe({...score,confidence:88},1500);
  assert.equal(result?.kind,'score');assert.equal(result?.score,19740);assert.equal(result?.confidence,88);
});

test('a score change, score-base change, blank interval or long gap resets stability',()=>{
  const first=parseResultScore(labelled()),second=parseResultScore(labelled({bodyText:'30,000円分のお寿司をゲット！10,000円払って20,000円分お得でした！'}));
  const reader=new StableScoreReader();
  assert.equal(reader.observe(first,1000),null);
  assert.equal(reader.observe(second,1600),null);
  assert.equal(reader.observe(second,2200)?.score,20000);
  const total=parseResultScore(labelled({scoreType:'total'}));
  assert.equal(reader.observe(total,2800),null);
  assert.equal(reader.observe({kind:'none',scoreType:'total',confidence:0},3400),null);
  assert.equal(reader.observe(total,4000),null);
  assert.equal(reader.observe(total,17000),null,'old observations cannot corroborate a later round');
  assert.equal(reader.observe(total,17600)?.score,29740);
});

test('a low-confidence observation cannot promote the next high-confidence frame by itself',()=>{
  const reader=new StableScoreReader(),high=parseResultScore(labelled()),low:ParsedScore={...high,kind:'review',confidence:40,reason:'uncertain'};
  assert.equal(reader.observe(low,1000),null);
  assert.equal(reader.observe(high,1600)?.kind,'review');
  assert.equal(reader.observe(high,2200)?.kind,'score');
  assert.equal(reader.observe(high,NaN),null);
  assert.equal(reader.observe(high,2800),null,'invalid observation clears prior state');
});
