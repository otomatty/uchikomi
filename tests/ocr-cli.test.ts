import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function check(script:string,args:string[],directory:string){
  return new Promise<{code:string|number;signal:string|null;killed:boolean;stderr:string}>(resolve=>{
    execFile(process.execPath,['--import','tsx',path.join(root,'tests',script),...args],{
      cwd:root,timeout:15000,maxBuffer:1024*1024,
      env:{...process.env,UCHIKOMI_OCR_LANG_PATH:path.join(directory,'missing-models'),UCHIKOMI_OCR_REPORT_DIR:directory},
    },(error,_stdout,stderr)=>resolve({code:error?.code??0,signal:error?.signal??null,killed:error?.killed??false,stderr}));
  });
}
for(const [script,reportName,args] of [
  ['ocr-check.mjs','ocr-report.json',[]],
  ['auto-ocr-check.mjs','auto-ocr-report.json',[path.join(root,'tests/ocr-fixtures/roman.png')]],
  ['score-ocr-check.mjs','score-ocr-report.json',[path.join(root,'tests/ocr-fixtures/roman.png')]],
] as const){
  test(`${script} reports a real missing-model failure and exits without a dangling worker`,{timeout:20000},async()=>{
    const directory=await mkdtemp(path.join(os.tmpdir(),'uchikomi-ocr-failure-'));
    try{
      const result=await check(script,[...args],directory);
      assert.equal(result.killed,false,'OCR check needed the test timeout to terminate');
      assert.equal(result.signal,null);assert.equal(result.code,1,result.stderr);
      const report=JSON.parse(await readFile(path.join(directory,reportName),'utf8'));
      assert.equal(report.startupFailed,true);assert.match(report.error,/ENOENT|missing-models/);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
}

test('auto OCR rejects explicit empty scales before startup while omitted scales retain the default',{timeout:20000},async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'uchikomi-ocr-cases-'));
  try{
    const manifest=path.join(directory,'cases.json'),file=path.join(root,'tests/ocr-fixtures/roman.png');
    await writeFile(manifest,JSON.stringify([{file,scales:[]}]));
    let result=await check('auto-ocr-check.mjs',['--cases',manifest],directory);
    assert.equal(result.killed,false);assert.equal(result.code,1);
    let report=JSON.parse(await readFile(path.join(directory,'auto-ocr-report.json'),'utf8'));
    assert.match(report.error,/Scales must be a non-empty array/);assert.equal(report.startupFailed,undefined);
    await writeFile(manifest,JSON.stringify([{file}]));
    result=await check('auto-ocr-check.mjs',['--cases',manifest],directory);
    assert.equal(result.killed,false);assert.equal(result.code,1);
    report=JSON.parse(await readFile(path.join(directory,'auto-ocr-report.json'),'utf8'));
    assert.equal(report.startupFailed,true);assert.match(report.error,/ENOENT|missing-models/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
