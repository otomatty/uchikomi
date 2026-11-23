/**
 * Verifies the shipped English/Japanese language assets against independent text fixtures.
 * npm run build && node tests/ocr-check.mjs
 * This is NOT a live-game capture test and does NOT verify browser CSP.
 */
import { createWorker, PSM } from 'tesseract.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const report={scope:'Independent text fixtures, local language models in Node; no real-game or browser-CSP assertion',checks:[]};
let eng,jpn;
try {
  [eng,jpn]=await Promise.all(['eng','jpn'].map(lang=>createWorker(lang,1,{langPath:path.join(root,'dist/vendor/lang'),gzip:true,cacheMethod:'none'})));
  await Promise.all([eng.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:'abcdefghijklmnopqrstuvwxyz'}),jpn.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE})]);
  for(const [name,expected,worker] of [['roman','pearukku',eng],['japanese','ペアルック',jpn],['reading','ぺあるっく',jpn]]) {
    const start=performance.now();
    const result=await worker.recognize(path.join(root,`tests/ocr-fixtures/${name}.png`));
    const actual=result.data.text.normalize('NFKC').replace(/\s+/g,'');
    const record={name,expected,actual,confidence:result.data.confidence,durationMs:Math.round(performance.now()-start),ok:actual===expected};
    report.checks.push(record);console.log(record);
    assert.equal(actual,expected);
  }
} catch(error) {
  report.error=String(error.stack||error);process.exitCode=1;console.error(error.message||error);
} finally {
  await Promise.all([eng?.terminate(),jpn?.terminate()]);
  await mkdir(path.join(root,'qa'),{recursive:true});
  await writeFile(path.join(root,'qa/ocr-report.json'),JSON.stringify(report,null,2));
}
