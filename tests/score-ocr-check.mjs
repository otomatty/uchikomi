/**
 * Optional, local result-screen PNG check using the shipped OCR pipeline.
 * npm run build
 * node --import tsx tests/score-ocr-check.mjs /path/result.png --expect-score 29740
 * node --import tsx tests/score-ocr-check.mjs /path/ranking.png --expect-none
 * Add --negative /path/ranking.png to check a rejected image in the same report.
 *
 * No images are bundled, uploaded or copied into the repository. This checks one
 * still image; it does not verify the two-independent-frame gate or live capture.
 */
import { PSM } from 'tesseract.js';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectResultRegions, findAmountRect, preprocessResultPixels } from '../src/capture/auto-result.ts';
import { parseResultScore } from '../src/capture/score-parser.ts';
import { pixelRect } from '../src/capture/helpers.ts';
import { startCheckWorkers, finishOcrCheck } from './ocr-check-support.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const report={scope:'Single PNG: automatic result regions, packaged offline OCR and score parsing. No live capture, persistence or two-frame stability claim.',createdAt:new Date().toISOString(),checks:[]};

function resizeCrop(image,area,width,height){
  const out=new PNG({width,height});
  const pixel=(x,y,c)=>image.data[(Math.max(0,Math.min(image.height-1,y))*image.width+Math.max(0,Math.min(image.width-1,x)))*4+c];
  for(let y=0;y<height;y++){
    const sy=area.y+(y+.5)*area.height/height-.5,y0=Math.floor(sy),fy=sy-y0;
    for(let x=0;x<width;x++){
      const sx=area.x+(x+.5)*area.width/width-.5,x0=Math.floor(sx),fx=sx-x0,i=(y*width+x)*4;
      for(let c=0;c<3;c++)out.data[i+c]=Math.round((pixel(x0,y0,c)*(1-fx)+pixel(x0+1,y0,c)*fx)*(1-fy)+(pixel(x0,y0+1,c)*(1-fx)+pixel(x0+1,y0+1,c)*fx)*fy);
      out.data[i+3]=255;
    }
  }
  return out;
}
function crop(image,rect,upscale=false){
  const area=pixelRect(rect,image.width,image.height),scale=upscale?Math.min(3,Math.max(2,56/area.height)):1;
  return resizeCrop(image,area,Math.max(1,Math.round(area.width*scale)),Math.max(1,Math.round(area.height*scale)));
}
function prepare(image,dark=false){
  const copy=new PNG({width:image.width,height:image.height});copy.data.set(image.data);
  preprocessResultPixels(copy.data,copy.width,copy.height,dark);
  return PNG.sync.write(copy);
}
const summary=data=>({text:data.text,confidence:data.confidence});

let eng,jpn;
try{
  const files=[];let expectedScore,expectNone=false;
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){
    const value=args[i];
    if(value==='--expect-score'){expectedScore=Number(args[++i]);assert.ok(Number.isSafeInteger(expectedScore)&&expectedScore>=0,'--expect-score requires a nonnegative food total');}
    else if(value==='--expect-none')expectNone=true;
    else if(value==='--negative'){const file=args[++i];assert.ok(file&&!file.startsWith('--'),'--negative requires a PNG path');files.push({file,negative:true});}
    else {assert.ok(!value.startsWith('--'),`Unknown option: ${value}`);files.push({file:value,negative:false});}
  }
  assert.ok(files.length,'Pass a local result PNG. Example: node --import tsx tests/score-ocr-check.mjs /path/result.png');
  assert.ok(!expectNone||expectedScore===undefined,'--expect-none cannot be combined with an expected score');
  [eng,jpn]=await startCheckWorkers(root,report);
  await Promise.all([
    eng.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:'0123456789,.',preserve_interword_spaces:'0'}),
    jpn.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,preserve_interword_spaces:'0'}),
  ]);
  for(const {file,negative} of files){
    const expectFileNone=expectNone||negative;
    const frame=PNG.sync.read(await readFile(file)),scale=Math.min(1,1280/Math.max(frame.width,frame.height));
    const search=scale===1?frame:resizeCrop(frame,{x:0,y:0,width:frame.width,height:frame.height},Math.round(frame.width*scale),Math.round(frame.height*scale));
    const started=performance.now(),regions=detectResultRegions(search);
    const check={file:path.basename(file),expectation:expectFileNone?'no-result':'score',size:[frame.width,frame.height],regions,detectionMs:Math.round((performance.now()-started)*10)/10,lines:{},numeric:{}};
    report.checks.push(check);
    if(!regions){check.ok=expectFileNone;console.log(JSON.stringify(check));assert.ok(expectFileNone,'No result receipt found');continue;}
    assert.equal(expectFileNone,false,'A result-like receipt was unexpectedly detected');
    const header=(await jpn.recognize(prepare(crop(frame,regions.header,true),true))).data;
    check.header=summary(header);
    let label={text:'',confidence:0},totalLabel={text:'',confidence:0};
    const body=[],bodyConfidences=[];
    for(const kind of ['total','paid','profit']){
      const line=crop(frame,regions[kind],true),numberRect=findAmountRect(line,kind);
      const [textResult,numberResult]=await Promise.all([
        jpn.recognize(prepare(line)),
        numberRect?eng.recognize(prepare(crop(line,numberRect))):Promise.resolve(null),
      ]);
      check.lines[kind]={...summary(textResult.data),numberRect};body.push(textResult.data.text);bodyConfidences.push(textResult.data.confidence);
      if(numberResult)check.numeric[kind]=summary(numberResult.data);
      if(kind==='total'||kind==='profit'){
        let recognizedLabel=summary(textResult.data);
        if(numberRect){
          const left=numberRect.x+numberRect.width;
          if(left<.8)recognizedLabel=summary((await jpn.recognize(prepare(crop(line,{x:left,y:0,width:1-left,height:1})))).data);
        }
        if(kind==='total')totalLabel=recognizedLabel;else label=recognizedLabel;
      }
    }
    check.label=label;check.totalLabel=totalLabel;
    check.parsed=parseResultScore({headerText:header.text,headerConfidence:header.confidence,bodyText:body.join('\n'),bodyConfidence:Math.min(...bodyConfidences),amountLines:check.lines,totalLabelText:totalLabel.text,totalLabelConfidence:totalLabel.confidence,labelText:label.text,labelConfidence:label.confidence,numeric:check.numeric,structureConfidence:regions.confidence});
    check.durationMs=Math.round(performance.now()-started);
    check.ok=check.parsed.kind==='score'&&check.parsed.scoreType==='total'&&(expectedScore===undefined||check.parsed.score===expectedScore);
    console.log(JSON.stringify(check));
    assert.equal(check.parsed.kind,'score','This image remains a review candidate; inspect qa/score-ocr-report.json');
    assert.equal(check.parsed.scoreType,'total');
    assert.equal(check.parsed.score,check.parsed.total);
    assert.equal(Object.hasOwn(check.parsed,'profit'),false);
    if(expectedScore!==undefined)assert.equal(check.parsed.score,expectedScore,'Score did not match expected value');
  }
}catch(error){
  report.error=String(error.stack||error);process.exitCode=1;console.error(error.message||error);
}finally{
  await finishOcrCheck(root,'score-ocr-report.json',report,[eng,jpn]);
}
