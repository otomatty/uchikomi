/**
 * Automatic prompt detection + offline OCR against PNG inputs.
 * npm run build && npm run test:auto-ocr
 * npm run test:auto-ocr -- /path/to/screenshot.png
 * npm run test:auto-ocr -- --cases /path/to/cases.json
 *
 * A cases JSON is [{file, expected:{reading,japanese,roman}, scales:[1,.75,1.25]}].
 * Relative image paths are resolved against the cases JSON directory.
 * With no arguments, composes an independent prompt from the existing text fixtures.
 * External screenshots are never copied into the repository or the report.
 * This is a Node image test; it does not verify tabCapture, browser CSP or live timing.
 */
import { PSM } from 'tesseract.js';
import { PNG } from 'pngjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPromptRegions } from '../src/capture/auto-region.ts';
import { normalizeJapanese, normalizeOcrRoman, normalizeReading, pixelRect, preprocessOcrPixels } from '../src/capture/helpers.ts';
import { resolveOcrReading } from '../src/capture/ocr-reading.ts';
import { startCheckWorkers, finishOcrCheck } from './ocr-check-support.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = {
  scope: 'Automatic image-region detection and locally packaged OCR models in Node; no live-game/browser-CSP claim',
  createdAt: new Date().toISOString(), cases: [],
};

/** Bilinear resampling of a crop; Canvas performs the runtime crop in Chrome. */
function resizeCrop(image, area, width, height) {
  const output = new PNG({ width, height });
  const at = (x, y, channel) => image.data[(Math.max(0, Math.min(image.height - 1, y)) * image.width + Math.max(0, Math.min(image.width - 1, x))) * 4 + channel];
  for (let y = 0; y < height; y++) {
    const sy = area.y + (y + .5) * area.height / height - .5;
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = area.x + (x + .5) * area.width / width - .5;
      const x0 = Math.floor(sx), fx = sx - x0;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) output.data[i + c] = Math.round((at(x0,y0,c)*(1-fx)+at(x0+1,y0,c)*fx)*(1-fy)+(at(x0,y0+1,c)*(1-fx)+at(x0+1,y0+1,c)*fx)*fy);
      output.data[i + 3] = 255;
    }
  }
  return output;
}

async function independentFixture(typedPrefix = false) {
  const frame = new PNG({ width: 1200, height: 850 });
  const fill = (x,y,w,h,r,g,b) => {
    for (let yy=y;yy<y+h;yy++) for (let xx=x;xx<x+w;xx++) {
      const i=(yy*frame.width+xx)*4;frame.data[i]=r;frame.data[i+1]=g;frame.data[i+2]=b;frame.data[i+3]=255;
    }
  };
  fill(0,0,1200,850,21,24,20);
  // Independent rounded white frame, 600 x 172. No game artwork is included.
  const box={x:300,y:360,w:600,h:172,r:16};
  for(let y=box.y;y<box.y+box.h;y++) for(let x=box.x;x<box.x+box.w;x++) {
    const lx=x-box.x,ly=y-box.y;
    const cx=Math.max(box.r,Math.min(box.w-box.r-1,lx));
    const cy=Math.max(box.r,Math.min(box.h-box.r-1,ly));
    if(Math.hypot(lx-cx,ly-cy)<=box.r) fill(x,y,1,1,255,255,255);
  }
  const inset=7;
  for(let y=box.y+inset;y<box.y+box.h-inset;y++) for(let x=box.x+inset;x<box.x+box.w-inset;x++) {
    const lx=x-box.x-inset,ly=y-box.y-inset,w=box.w-inset*2,h=box.h-inset*2,r=box.r-inset;
    const cx=Math.max(r,Math.min(w-r-1,lx)),cy=Math.max(r,Math.min(h-r-1,ly));
    if(Math.hypot(lx-cx,ly-cy)<=r) fill(x,y,1,1,35,31,21);
  }
  for(const [kind,top,height] of [['reading',377,25],['japanese',410,38],['roman',461,34]]) {
    const source=PNG.sync.read(await readFile(path.join(root,`tests/ocr-fixtures/${kind}.png`)));
    let left=source.width,right=0,bottom=0,first=source.height;
    for(let y=0;y<source.height;y++) for(let x=0;x<source.width;x++) {
      const i=(y*source.width+x)*4;
      if(Math.min(...source.data.subarray(i,i+3))<180){left=Math.min(left,x);right=Math.max(right,x);first=Math.min(first,y);bottom=Math.max(bottom,y);}
    }
    const area={x:left-2,y:first-2,width:right-left+5,height:bottom-first+5};
    const width=Math.round(area.width*height/area.height);
    const line=resizeCrop(source,area,width,height);
    const start=Math.round((frame.width-width)/2);
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const i=(y*width+x)*4;const ink=(255-Math.min(...line.data.subarray(i,i+3)))/255;
      const red=typedPrefix&&kind==='roman'&&x<width*.5;
      fill(start+x,top+y,1,1,Math.round(35+220*ink),Math.round(31+(red?35:224)*ink),Math.round(21+(red?24:234)*ink));
    }
  }
  return frame;
}

let eng,jpn;
try {
  const args=process.argv.slice(2);
  let cases;
  if(args[0]==='--cases') {
    assert.equal(args.length,2,'Usage: --cases /path/to/cases.json');
    const manifest=path.resolve(args[1]);
    cases=JSON.parse(await readFile(manifest,'utf8'));
    assert.ok(Array.isArray(cases)&&cases.length,'Cases must be a non-empty array');
    cases=cases.map(item=>({...item,file:path.resolve(path.dirname(manifest),item.file)}));
  } else if(args.length) {
    assert.ok(args.every(item=>!item.startsWith('--')),'Use PNG paths, or --cases cases.json');
    cases=args.map(file=>({file:path.resolve(file),scales:[1]}));
  } else {
    cases=await Promise.all([false,true].map(async typedPrefix=>({name:typedPrefix?'independent-red-prefix':'independent-prompt',image:await independentFixture(typedPrefix),expected:{reading:'ぺあるっく',japanese:'ペアルック',roman:'pearukku'},scales:[1]})));
  }
  cases=cases.map(item=>{
    const scales=item.scales===undefined?[1]:item.scales;
    assert.ok(Array.isArray(scales)&&scales.length,'Scales must be a non-empty array');
    assert.ok(scales.every(scale=>Number.isFinite(scale)&&scale>0&&scale<=4),'Scale must be within (0,4]');
    return {...item,scales};
  });
  [eng,jpn]=await startCheckWorkers(root,report);
  await Promise.all([
    eng.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,-'/():;[]",preserve_interword_spaces:'0'}),
    jpn.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,preserve_interword_spaces:'0'}),
  ]);
  let failed=0;
  for(const item of cases) {
    const original=item.image??PNG.sync.read(await readFile(item.file));
    for(const scale of item.scales) {
      const frame=scale===1?original:resizeCrop(original,{x:0,y:0,width:original.width,height:original.height},Math.round(original.width*scale),Math.round(original.height*scale));
      // Runtime searches a viewport downscaled to at most 1280 px on its longer edge.
      const detectionScale=Math.min(1,1280/Math.max(frame.width,frame.height));
      const search=detectionScale===1?frame:resizeCrop(frame,{x:0,y:0,width:frame.width,height:frame.height},Math.round(frame.width*detectionScale),Math.round(frame.height*detectionScale));
      const start=performance.now();
      const regions=detectPromptRegions(search);
      const record={name:item.name??path.basename(item.file),scale,size:[frame.width,frame.height],detectionMs:Math.round((performance.now()-start)*10)/10,regions,lines:[],ok:!!regions};
      report.cases.push(record);
      if(!regions){failed++;console.log(`${record.name} @ ${scale}: prompt not found`);continue;}
      for(const [kind,worker,normalize] of [['reading',jpn,normalizeReading],['japanese',jpn,normalizeJapanese],['roman',eng,normalizeOcrRoman]]) {
        const area=pixelRect(regions[kind],frame.width,frame.height);
        const factor=Math.min(3,Math.max(2,56/area.height));
        const line=resizeCrop(frame,area,Math.max(1,Math.round(area.width*factor)),Math.max(1,Math.round(area.height*factor)));
        const data=new Uint8ClampedArray(line.data.buffer,line.data.byteOffset,line.data.byteLength);
        preprocessOcrPixels(data,line.width,line.height);
        const t=performance.now(),result=await worker.recognize(PNG.sync.write(line));
        const actual=normalize(result.data.text),expected=item.expected?.[kind];
        const ok=expected===undefined?actual.length>0:actual===expected;
        record.lines.push({kind,actual,...(expected===undefined?{}:{expected}),confidence:result.data.confidence,durationMs:Math.round(performance.now()-t),ok});
      }
      const values=Object.fromEntries(record.lines.map(line=>[line.kind,line.actual]));
      const confidences=Object.fromEntries(record.lines.map(line=>[line.kind,line.confidence]));
      const resolution=resolveOcrReading({...values,japaneseConfidence:confidences.japanese,readingConfidence:confidences.reading,romanConfidence:confidences.roman});
      record.readingResolution=resolution;
      const readingLine=record.lines.find(line=>line.kind==='reading');
      if(resolution.source==='title') {
        readingLine.observed=readingLine.actual;
        readingLine.actual=resolution.reading;
        readingLine.ok=readingLine.expected===undefined?resolution.consistent:readingLine.actual===readingLine.expected;
      }
      record.ok=record.lines.every(line=>line.ok);
      record.readingConsistent=resolution.consistent;
      record.ocrAutoVerified=resolution.consistent&&Math.min(confidences.japanese,confidences.roman,resolution.confidence)>=82&&confidences.japanese>=85&&confidences.roman>=88;
      if(!record.ok)failed++;
      console.log(JSON.stringify(record));
    }
  }
  report.passed=report.cases.filter(item=>item.ok).length;
  report.total=report.cases.length;
  assert.ok(report.total>0,'No OCR cases were executed');
  assert.equal(failed,0,`${failed} image cases failed; inspect qa/auto-ocr-report.json`);
} catch(error) {
  report.error=String(error.stack||error);process.exitCode=1;console.error(error.message||error);
} finally {
  await finishOcrCheck(root,'auto-ocr-report.json',report,[eng,jpn]);
}
