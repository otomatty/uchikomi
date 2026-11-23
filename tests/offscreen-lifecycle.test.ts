import 'fake-indexeddb/auto';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { transform } from 'esbuild';
import * as db from '../src/core/db';
import { DEFAULT_SETTINGS } from '../src/core/types';

const nativeChannel = globalThis.BroadcastChannel;
(globalThis as any).BroadcastChannel = undefined;
after(() => { globalThis.BroadcastChannel = nativeChannel; });
beforeEach(() => db.clearData());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(startWorkers: (...args: any[]) => Promise<any[]>, receipt?: boolean) {
  const filename = new URL('../src/capture/offscreen.ts', import.meta.url);
  const source = await transform(await readFile(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' });
  const load = createRequire(filename);
  let listener: ((message: any, sender: any, reply: (result: any) => void) => unknown) | undefined;
  const states: any[] = [], intervals = new Set<unknown>();
  let stoppedTracks = 0;
  const video = { muted: false, playsInline: false, readyState: 0, videoWidth: 0, videoHeight: 0, srcObject: null, async play() {} };
  const track = { stop() { stoppedTracks++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const context = {
    module: { exports: {} }, exports: {}, console, crypto: globalThis.crypto, AbortController,
    setTimeout, clearTimeout,
    setInterval() { const id = {}; intervals.add(id); return id; },
    clearInterval(id: unknown) { intervals.delete(id); },
    document: {
      body: { append() {} },
      createElement(tag: string) {
        return tag === 'video' ? video : {
          width: 0, height: 0, toDataURL: () => 'data:image/jpeg;base64,AA==',
          getContext: () => ({ drawImage() {}, fillRect() {}, getImageData: () => ({ width: 1280, height: 800, data: [] }) }),
        };
      },
    },
    navigator: { mediaDevices: { async getUserMedia() { return stream; } } },
    chrome: { runtime: {
      id: 'offscreen-test', getURL: (path: string) => 'chrome-extension://offscreen-test/' + path,
      async sendMessage(message: any) { if (message.type === 'UCHI_OFF_STATE') states.push(structuredClone(message.status)); return { ok: true }; },
      onMessage: { addListener(value: typeof listener) { listener = value; } },
    } },
    require(name: string) {
      if (name === './ocr-worker') return { startOcrWorkers: startWorkers };
      if (name === '../core/db') return db;
      if (name === 'tesseract.js') return { PSM: { SINGLE_LINE: '7' } };
      if (receipt !== undefined && name === './auto-region') return { detectPromptRegions: () => null };
      if (receipt !== undefined && name === './auto-result') return {
        ...load(name), detectResultRegions: () => {
          if (!receipt) return null;
          const row = { x: .2, y: .2, width: .4, height: .05 };
          return { panel: row, header: row, total: row, paid: row, profit: row, confidence: .98 };
        },
      };
      return load(name);
    },
  };
  // Run the actual module with only browser media surfaces and OCR startup
  // substituted. No Chromium, game page, OCR engine or screen access is used.
  const runtime = vm.createContext(context);
  vm.runInContext(source.code, runtime, { filename: filename.pathname });
  const request = (type: string, extra: object = {}) => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${type} did not settle`)), 1000);
    const keepAlive = listener?.({ target: 'offscreen', type, ...extra }, { id: 'offscreen-test' }, result => {
      clearTimeout(timeout); resolve(result);
    });
    assert.equal(keepAlive, true);
  });
  return {
    request, states, intervals, evaluate: (code: string) => vm.runInContext(code, runtime),
    stoppedTracks: () => stoppedTracks,
    async start() {
      const result = await request('UCHI_OFF_START', {
        streamId: 'test-stream', tabId: 1, sessionId: 'startup-test', startedAt: Date.now(), settings: DEFAULT_SETTINGS,
      });
      assert.equal(result.ok, true);
      assert.equal(result.status.state, 'recording');
    },
  };
}

test('stop detaches pending OCR startup and terminates workers that arrive afterwards', async () => {
  const pending = deferred<any[]>();
  let signal!: AbortSignal;
  const app = await fixture((_langs, _options, controls) => { signal = controls.signal; return pending.promise; });
  await app.start();
  const stopped = await app.request('UCHI_OFF_STOP');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status.state, 'idle');
  assert.equal(signal.aborted, true);
  assert.equal(app.stoppedTracks(), 1);
  assert.equal(app.intervals.size, 0);
  let terminated = 0, parameterCalls = 0;
  const worker = () => ({ async terminate() { terminated++; }, async setParameters() { parameterCalls++; } });
  pending.resolve([worker(), worker()]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminated, 2);
  assert.equal(parameterCalls, 0);
  assert.equal(app.states.some(state => state.ocrReady), false);
  assert.ok((await db.getData()).sessions[0].endedAt);
});

test('stop terminates already obtained workers without waiting for parameter setup', async () => {
  const parameters = deferred<void>();
  let terminated = 0, parameterCalls = 0;
  const worker = () => ({ async terminate() { terminated++; }, setParameters() { parameterCalls++; return parameters.promise; } });
  const app = await fixture(async () => [worker(), worker()]);
  await app.start();
  assert.equal(parameterCalls, 2);
  const stopped = await app.request('UCHI_OFF_STOP');
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status.state, 'idle');
  assert.equal(terminated, 2);
  assert.equal(app.stoppedTracks(), 1);
  assert.equal(app.intervals.size, 0);
  parameters.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminated, 2);
  assert.equal(app.states.some(state => state.ocrReady), false);
});

test('the actual region scan recognizes a receipt before invalidating the final candidate', async () => {
  for (const receipt of [true, false]) {
    const app = await fixture(() => new Promise(() => {}), receipt);
    await app.start();
    const result = app.evaluate(`
      status.ocrReady = true;
      video.readyState = 2; video.videoWidth = 1280; video.videoHeight = 800;
      activeGame.observedPrompt = true;
      calibration = { japanese: {x:.2,y:.2,width:.4,height:.05}, roman: {x:.2,y:.3,width:.4,height:.05} };
      currentCandidate = {
        game: activeGame, at: Date.now() - 1000, reliableBoundary: true,
        processed: false, completionBoundary: require('./key-boundary').createCompletionBoundary(),
      };
      const disappearedAt = Date.now();
      scanRegions(disappearedAt);
      ({ endedAt: currentCandidate.endedAt, disappearedAt, reliable: currentCandidate.reliableBoundary, receipt: activeGame.resultSeen });
    `);
    assert.equal(result.endedAt, result.disappearedAt);
    assert.equal(result.reliable, receipt);
    assert.equal(result.receipt, receipt);
    assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
  }
});
