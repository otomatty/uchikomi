import test from 'node:test';
import assert from 'node:assert/strict';
import type { Worker, WorkerOptions } from 'tesseract.js';
import { startOcrWorker, startOcrWorkers, type OcrStartupOptions } from '../src/capture/ocr-worker';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fakeWorker() {
  let terminated = 0;
  return { worker: { terminate: async () => { terminated++; } } as unknown as Worker, count: () => terminated };
}
function deferred<T>() {
  let resolve!: (value:T) => void, reject!: (reason:unknown) => void;
  return { promise: new Promise<T>((yes,no) => { resolve=yes; reject=no; }), resolve, reject };
}
type Factory = NonNullable<OcrStartupOptions['createWorker']>;

test('callback-only initialization failure rejects immediately and releases a late worker',{timeout:1000},async()=>{
  const late=deferred<Worker>(),fake=fakeWorker();let options:Partial<WorkerOptions>={};const errors:unknown[]=[];
  const pending=startOcrWorker('eng',{errorHandler:error=>errors.push(error)},{createWorker:((_lang,_oem,value)=>{options=value!;return late.promise;}) as Factory});
  options.errorHandler!('missing traineddata');
  await assert.rejects(pending,/missing traineddata/);assert.deepEqual(errors,['missing traineddata']);
  late.resolve(fake.worker);await tick();assert.equal(fake.count(),1);
});

test('abort settles a pending initialization and disposes any later result',{timeout:1000},async()=>{
  const controller=new AbortController(),late=deferred<Worker>(),fake=fakeWorker();
  const pending=startOcrWorker('eng',{}, {signal:controller.signal,createWorker:(()=>late.promise) as Factory});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
  late.resolve(fake.worker);await tick();assert.equal(fake.count(),1);
  let called=false;
  await assert.rejects(startOcrWorker('eng',{}, {signal:controller.signal,createWorker:(()=>{called=true;return late.promise;}) as Factory}),{name:'AbortError'});
  assert.equal(called,false);
});

test('initialization timeout settles a silent factory and handles a later rejection',{timeout:1000},async()=>{
  const late=deferred<Worker>();
  await assert.rejects(startOcrWorker('eng',{}, {timeoutMs:10,createWorker:(()=>late.promise) as Factory}),/timed out/);
  late.reject(new Error('late failure'));await tick();
});

test('synchronous and ordinary factory rejections follow the same failure path',async()=>{
  await assert.rejects(startOcrWorker('eng',{}, {createWorker:(()=>{throw new Error('spawn failed');}) as Factory}),/spawn failed/);
  await assert.rejects(startOcrWorker('eng',{}, {createWorker:(()=>Promise.reject(new Error('load failed'))) as Factory}),/load failed/);
});

test('successful startup transfers ownership and keeps runtime error reporting',async()=>{
  const controller=new AbortController(),fake=fakeWorker();let options:Partial<WorkerOptions>={};const errors:unknown[]=[];
  const worker=await startOcrWorker('eng',{errorHandler:error=>errors.push(error)}, {signal:controller.signal,createWorker:((_lang,_oem,value)=>{options=value!;return Promise.resolve(fake.worker);}) as Factory});
  controller.abort();options.errorHandler!('recognition failed');await tick();
  assert.equal(worker,fake.worker);assert.equal(fake.count(),0);assert.deepEqual(errors,['recognition failed']);
  await worker.terminate();assert.equal(fake.count(),1);
});

test('group failure releases an acquired sibling and a late sibling without waiting for either startup',{timeout:1000},async()=>{
  const acquired=fakeWorker(),lateFake=fakeWorker(),late=deferred<Worker>();let fail!: (error:unknown)=>void;
  const pending=startOcrWorkers(['eng','jpn','late'],{}, {createWorker:((lang,_oem,options)=>{
    if(lang==='eng')return Promise.resolve(acquired.worker);
    if(lang==='late')return late.promise;
    fail=options!.errorHandler!;return new Promise(()=>{});
  }) as Factory});
  await tick();fail('Japanese model missing');await assert.rejects(pending,/Japanese model missing/);
  assert.equal(acquired.count(),1);late.resolve(lateFake.worker);await tick();assert.equal(lateFake.count(),1);
});

test('group cancellation releases acquired workers while unresolved startups remain bounded',{timeout:1000},async()=>{
  const controller=new AbortController(),fake=fakeWorker();
  const pending=startOcrWorkers(['eng','jpn'],{}, {signal:controller.signal,createWorker:((lang)=>lang==='eng'?Promise.resolve(fake.worker):new Promise(()=>{})) as Factory});
  await tick();controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(fake.count(),1);
});
