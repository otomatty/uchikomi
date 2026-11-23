import 'fake-indexeddb/auto';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { transform } from 'esbuild';
import * as db from '../src/core/db';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { dailyTraining } from '../src/core/activity';

const nativeChannel = globalThis.BroadcastChannel;
(globalThis as any).BroadcastChannel = undefined;
after(() => { globalThis.BroadcastChannel = nativeChannel; });
beforeEach(() => db.clearData());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

interface FixtureOptions {
  scene?: { prompt: boolean; receipt: boolean; variant?: number };
  clock?: () => number;
  decode?: () => Promise<void>;
}

async function fixture(startWorkers: (...args: any[]) => Promise<any[]>, receipt?: boolean, options: FixtureOptions = {}) {
  const filename = new URL('../src/capture/offscreen.ts', import.meta.url);
  const source = await transform(await readFile(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' });
  const load = createRequire(filename);
  let listener: ((message: any, sender: any, reply: (result: any) => void) => unknown) | undefined;
  const states: any[] = [], images: any[] = [];
  const intervals = new Map<unknown, { callback: () => void; delay: number }>();
  let stoppedTracks = 0, mediaCalls = 0;
  const video = { muted: false, playsInline: false, readyState: 0, videoWidth: 0, videoHeight: 0, srcObject: null, async play() {} };
  const track = { stop() { stoppedTracks++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const context = {
    module: { exports: {} }, exports: {}, console, crypto: globalThis.crypto, AbortController,
    Date: class extends Date { static now() { return options.clock?.() ?? Date.now(); } },
    Image: class {
      src = ''; naturalWidth = 1280; naturalHeight = 800;
      constructor() { images.push(this); }
      async decode() { await options.decode?.(); }
    },
    setTimeout, clearTimeout,
    setInterval(callback: () => void, delay: number) { const id = {}; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id: unknown) { intervals.delete(id); },
    document: {
      body: { append() {} },
      createElement(tag: string) {
        return tag === 'video' ? video : {
          width: 0, height: 0, toDataURL: () => 'data:image/jpeg;base64,AA==',
          getContext: () => ({
            drawImage() {}, fillRect() {}, putImageData() {},
            getImageData(_x: number, _y: number, width: number, height: number) {
              const data = new Uint8ClampedArray(width * height * 4).fill(255);
              // Two distinct, stable text-like signatures let the real prompt
              // tracker establish and lose continuity without replacing it.
              if (width === 192 && height === 32) {
                const left = options.scene?.variant ? 104 : 24;
                for (let y = 8; y < 24; y++) for (let x = left; x < left + 48; x++) {
                  const offset = (y * width + x) * 4;
                  data[offset] = data[offset + 1] = data[offset + 2] = 0;
                }
              }
              return { width, height, data };
            },
          }),
        };
      },
    },
    navigator: { mediaDevices: { async getUserMedia() { mediaCalls++; return stream; } } },
    chrome: { runtime: {
      id: 'offscreen-test', getURL: (path: string) => 'chrome-extension://offscreen-test/' + path,
      async sendMessage(message: any) { if (message.type === 'UCHI_OFF_STATE') states.push(structuredClone(message.status)); return { ok: true }; },
      onMessage: { addListener(value: typeof listener) { listener = value; } },
    } },
    require(name: string) {
      if (name === './ocr-worker') return { startOcrWorkers: startWorkers };
      if (name === '../core/db') return db;
      if (name === 'tesseract.js') return { PSM: { SINGLE_LINE: '7' } };
      if ((receipt !== undefined || options.scene) && name === './auto-region') return { detectPromptRegions: () => {
        if (!options.scene?.prompt) return null;
        return { panel: { x: .2, y: .3, width: .5, height: .2 }, japanese: { x: .22, y: .35, width: .46, height: .05 },
          reading: { x: .22, y: .31, width: .46, height: .03 }, roman: { x: .22, y: .42, width: .46, height: .05 }, confidence: .98 };
      } };
      if ((receipt !== undefined || options.scene) && name === './auto-result') return {
        ...load(name), findAmountRect: () => null, detectResultRegions: () => {
          if (!(options.scene?.receipt ?? receipt)) return null;
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
    let replied = false;
    const keepAlive = listener?.({ target: 'offscreen', type, ...extra }, { id: 'offscreen-test' }, result => {
      replied = true; clearTimeout(timeout); resolve(result);
    });
    assert.ok(keepAlive === true || replied, `${type} must reply or keep its channel open`);
  });
  return {
    request, states, intervals, images, evaluate: (code: string) => vm.runInContext(code, runtime),
    stoppedTracks: () => stoppedTracks, mediaCalls: () => mediaCalls,
    async start(extra: object = {}) {
      const result = await request('UCHI_OFF_START', {
        streamId: 'test-stream', tabId: 1, sessionId: 'startup-test', startedAt: options.clock?.() ?? Date.now(), settings: DEFAULT_SETTINGS, ...extra,
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


function frame(at: number, sequence: number, extra: object = {}) {
  return { dataUrl: 'data:image/jpeg;base64,AA==', width: 1280, height: 800, at, sequence, ...extra };
}
const canvasStart = { source: 'canvas', streamId: undefined };
const receiptLines = ['高級10,000円コース【正確重視】', '29,740円分のお寿司をゲット！', '10,000円払って…', '19,740円分お得でした！'];
function receiptWorkers() {
  let line = 0;
  return [
    { async setParameters() {}, async terminate() {}, async recognize() { return { data: { text: receiptLines[line++ % 4], confidence: 96 } }; } },
    { async setParameters() {}, async terminate() {}, async recognize() { throw new Error('No numeric crop in this fixture'); } },
  ];
}

test('canvas start needs no tab stream, starts no image timer, and leaves no empty menu session', async () => {
  const app = await fixture(() => new Promise(() => {}), false);
  await app.start(canvasStart);
  assert.equal(app.mediaCalls(), 0);
  assert.equal(app.evaluate('status.source'), 'canvas');
  assert.deepEqual([...app.intervals.values()].map(item => item.delay), [5000, 15000]);
  assert.equal((await db.getData()).sessions.length, 0);
  assert.equal((await app.request('UCHI_OFF_FRAME')).ok, false);
  assert.equal((await app.request('UCHI_OFF_START', { ...canvasStart, tabId: 1, sessionId: 'duplicate' })).ok, false);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
  assert.equal(app.stoppedTracks(), 0);
  assert.equal(app.intervals.size, 0);
  assert.equal((await db.getData()).sessions.length, 0);
});

test('the first canvas prompt starts its game at capture time and supplies snapshot and calibration coordinates', async () => {
  let now = 1700000000000;
  const scene = { prompt: false, receipt: false };
  const app = await fixture(() => new Promise(() => {}), undefined, { scene, clock: () => now });
  await app.start(canvasStart);
  now += 80;
  assert.equal((await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, 1) })).ok, true);
  assert.equal((await db.getData()).sessions.length, 0);
  scene.prompt = true; now += 240;
  await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, 2) });
  const data = await db.getData();
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].id, 'startup-test');
  assert.equal(data.sessions[0].startedAt, now);
  const snapshot = await app.request('UCHI_OFF_FRAME');
  assert.equal(snapshot.ok, true);
  assert.deepEqual({ ...snapshot.frame }, { dataUrl: 'data:image/jpeg;base64,AA==', width: 1280, height: 800, at: now });
  assert.equal(app.evaluate('calibration.viewport.width'), 1280);
  assert.equal(app.evaluate('calibration.viewport.height'), 800);
  const calibration = { japanese: { x: .2, y: .3, width: .5, height: .05 }, roman: { x: .2, y: .4, width: .5, height: .05 }, viewport: { width: 1280, height: 800 }, updatedAt: now };
  assert.equal((await app.request('UCHI_OFF_CALIBRATE', { calibration })).ok, true);
  assert.equal(app.evaluate('lastFrameWidth'), 1280);
  assert.equal(app.evaluate('lastFrameHeight'), 800);
  assert.equal(app.evaluate('manualRegions'), true);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
  assert.equal((await app.request('UCHI_OFF_FRAME')).ok, false);
});

test('canvas input rejects foreign, stale, oversized and incorrectly decoded frames before they change its image', async () => {
  let now = 1700000000000;
  const app = await fixture(() => new Promise(() => {}), false, { clock: () => now });
  await app.start(canvasStart);
  const send = (value: object, sessionId = 'startup-test') => app.request('UCHI_OFF_CANVAS_FRAME', { sessionId, frame: value });
  assert.equal((await send(frame(now, 1), 'different-session')).dropped, true);
  assert.equal(app.images.length, 0);
  for (const invalid of [{ width: 1921 }, { height: 1441 }, { width: 1.5 }, { sequence: NaN }, { at: Infinity }, { dataUrl: 'data:image/png;base64,AA==' }, { dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(3_000_000) }]) {
    assert.equal((await send(frame(now, 1, invalid))).ok, false);
  }
  assert.equal(app.images.length, 0);
  assert.equal((await send(frame(now, 1))).ok, true);
  now += 100;
  for (const stale of [frame(now, 1), frame(now - 100, 2), frame(now - 101, 2), frame(now + 1001, 2)]) {
    assert.equal((await send(stale)).dropped, true);
  }
  assert.equal(app.images.length, 1);
  assert.equal((await send(frame(now, 2, { width: 1200 }))).ok, false);
  const snapshot = await app.request('UCHI_OFF_FRAME');
  assert.equal(snapshot.frame.width, 1280);
  assert.equal(snapshot.frame.at, now - 100);
  assert.equal((await send(frame(now, 2))).ok, true);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
  assert.equal((await send(frame(now + 80, 3))).dropped, true);
});

test('parallel or pre-stop canvas decodes never overwrite the current capture generation', async () => {
  let now = 1700000000000;
  const decodes = [deferred<void>(), deferred<void>()];
  let decodeIndex = 0;
  const scene = { prompt: true, receipt: false };
  const app = await fixture(() => new Promise(() => {}), undefined, { scene, clock: () => now, decode: () => decodes[decodeIndex++].promise });
  await app.start(canvasStart);
  const first = app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, 1) });
  now += 80;
  assert.equal((await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, 2) })).dropped, true);
  assert.equal(decodeIndex, 1);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
  await app.start({ ...canvasStart, sessionId: 'next-capture' });
  now += 80;
  const current = app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'next-capture', frame: frame(now, 1) });
  assert.equal(decodeIndex, 2);
  decodes[0].resolve();
  assert.equal((await first).dropped, true);
  now += 80;
  assert.equal((await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'next-capture', frame: frame(now, 2) })).dropped, true);
  assert.equal(decodeIndex, 2, 'an old decode must not release the new generation’s in-flight lock');
  decodes[1].resolve();
  assert.equal((await current).ok, true);
  const sessions = (await db.getData()).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'next-capture');
  assert.equal(sessions[0].startedAt, now - 80);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
});

test('late focus and viewport messages from another session cannot invalidate the live canvas observation', async () => {
  let now = 1700000000000;
  const scene = { prompt: true, receipt: false };
  const app = await fixture(() => new Promise(() => {}), undefined, { scene, clock: () => now });
  await app.start(canvasStart);
  now += 80;
  await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, 1) });
  assert.equal(app.evaluate('Boolean(calibration)'), true);
  await app.request('UCHI_OFF_GAP', { sessionId: 'previous-capture', at: now });
  await app.request('UCHI_OFF_VIEW_CHANGE', { sessionId: 'previous-capture', at: now });
  assert.equal(app.evaluate('focusGaps.length'), 0);
  assert.equal(app.evaluate('Boolean(calibration)'), true);
  await app.request('UCHI_OFF_GAP', { sessionId: 'startup-test', at: now });
  assert.equal(app.evaluate('focusGaps.length'), 1);
  await app.request('UCHI_OFF_VIEW_CHANGE', { sessionId: 'startup-test', at: now });
  assert.equal(app.evaluate('Boolean(calibration)'), false);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
  await app.request('UCHI_OFF_GAP', { sessionId: 'startup-test', at: now });
  assert.equal(app.evaluate('focusGaps.length'), 0);
});

test('a missing canvas interval breaks a real stable prompt handoff and reacquires from fresh observations', async () => {
  let now = 1700000000000, sequence = 0;
  const scene = { prompt: true, receipt: false, variant: 0 };
  const app = await fixture(() => new Promise(() => {}), undefined, { scene, clock: () => now });
  await app.start(canvasStart);
  app.evaluate('status.ocrReady = true');
  const send = async (delay = 80) => {
    now += delay;
    assert.equal((await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, ++sequence) })).ok, true);
  };
  await send(); await send();
  assert.equal(app.evaluate('currentCandidate.reliableBoundary'), false);
  scene.variant = 1;
  await send(); await send();
  assert.equal(app.evaluate('currentCandidate.reliableBoundary'), true);
  app.evaluate('globalThis.beforeGap = currentCandidate');
  await send(320);
  assert.equal(app.evaluate('globalThis.beforeGap.reliableBoundary'), false);
  assert.equal(app.evaluate('globalThis.beforeGap.endedAt'), now);
  assert.equal(await app.evaluate('globalThis.beforeGap.completionBoundary.promise'), null);
  await send();
  assert.equal(app.evaluate('currentCandidate.reliableBoundary'), false);
  assert.equal(app.evaluate('currentCandidate.at'), now - 80);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
});

async function resultFixture() {
  let now = 1700000000000, sequence = 0;
  const scene = { prompt: true, receipt: false };
  const ready = deferred<any[]>();
  const app = await fixture(() => ready.promise, undefined, { scene, clock: () => now });
  await app.start(canvasStart);
  const send = async (delay = 80) => {
    now += delay;
    const response = await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, ++sequence) });
    assert.equal(response.ok, true);
    await app.evaluate('processQueue()');
  };
  await send();
  ready.resolve(receiptWorkers());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.evaluate('status.ocrReady'), true);
  scene.prompt = false; scene.receipt = true;
  await send(240);
  assert.equal(app.evaluate('activeGame.lastResult.parsed.score'), 29740);
  assert.equal((await db.getData()).sessions[0].score, undefined);
  return { app, send, get now() { return now; }, advance(delay: number) { now += delay; } };
}

test('one canvas receipt cannot become two observations from timers, repeat delivery or stop', async () => {
  const run = await resultFixture(), app = run.app;
  run.advance(600);
  for (const interval of app.intervals.values()) interval.callback();
  const duplicate = await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(run.now - 600, 2) });
  assert.equal(duplicate.dropped, true);
  assert.equal((await db.getData()).sessions[0].score, undefined);
  assert.equal((await app.request('UCHI_OFF_STOP')).ok, true);
  const saved = (await db.getData()).sessions[0];
  assert.equal(saved.score, undefined);
  assert.equal(saved.scoreReview?.score, 29740);
  assert.match(saved.scoreReview?.reason ?? '', /2回/);
});

test('separate continuous canvas result frames automatically save the total once', async () => {
  const run = await resultFixture();
  for (let i = 0; i < 15; i++) await run.send();
  const data = await db.getData();
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].score, 29740);
  assert.equal(data.sessions[0].scoreType, 'total');
  assert.equal(data.sessions[0].scoreReview, undefined);
  await run.send();
  assert.equal((await run.app.request('UCHI_OFF_STOP')).ok, true);
  assert.equal((await db.getData()).sessions.length, 1);
});

test('a canvas frame gap requires two fresh receipt observations before saving', async () => {
  const run = await resultFixture();
  await run.send(320);
  assert.equal((await db.getData()).sessions[0].score, undefined);
  for (let i = 0; i < 15; i++) await run.send();
  assert.equal((await db.getData()).sessions[0].score, 29740);
  assert.equal((await run.app.request('UCHI_OFF_STOP')).ok, true);
});


async function activityFixture(base = Date.parse('2026-12-24T14:59:59.000Z')) {
  let now = base, sequence = 0;
  const scene = { prompt: false, receipt: false };
  // Real prompt geometry is enough to retain physical volume even when text
  // recognition never produces a usable phrase or an accurate speed result.
  const worker = () => ({ async setParameters() {}, async terminate() {}, async recognize() { return { data: { text: '?', confidence: 10 } }; } });
  const app = await fixture(async () => [worker(), worker()], undefined, { scene, clock: () => now });
  await app.start(canvasStart); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.evaluate('status.ocrReady'), true);
  const keys = async (values: [number, string][]) => {
    const strokes = values.map(([offset, key]) => ({ key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`, at: base + offset }));
    now = Math.max(now, ...strokes.map(stroke => stroke.at));
    await app.request('UCHI_OFF_KEYS', { sessionId: 'startup-test', keys: strokes });
  };
  const observed = async (offset: number) => {
    now = base + offset;
    assert.equal((await app.request('UCHI_OFF_CANVAS_FRAME', { sessionId: 'startup-test', frame: frame(now, ++sequence) })).ok, true);
    await app.evaluate('processQueue()');
  };
  const checkpoint = async () => {
    for (const timer of app.intervals.values()) if (timer.delay === 5000) timer.callback();
    await app.evaluate('Promise.all(games.map(game => game.writes))');
  };
  const gap = async (type: 'UCHI_OFF_GAP' | 'UCHI_OFF_VIEW_CHANGE', offset: number) => {
    now = base + offset; await app.request(type, { sessionId: 'startup-test', at: now });
  };
  return { app, scene, keys, observed, checkpoint, gap, base };
}

test('capture checkpoints retain uncertain physical input across JST days without menu keys or duplicate batches', async () => {
  const run = await activityFixture();
  await run.keys([[20, ' ']]); await run.observed(80);
  assert.equal((await db.getData()).sessions.length, 0);
  run.scene.prompt = true;
  const typed: [number, string][] = [[350, 'a'], [450, ' '], [750, 'b'], [1050, 'c']];
  let sent = 0;
  for (let at = 320; at <= 1280; at += 80) {
    while (sent < typed.length && typed[sent][0] <= at) { await run.keys([typed[sent]]); sent++; }
    await run.observed(at);
  }
  await run.keys(typed); // Repeated delivery is not another set of physical keys.
  await run.checkpoint();
  const measured = [
    { date: '2026-12-24', activeMs: 650, keys: 3, phrases: 1 },
    { date: '2026-12-25', activeMs: 50, keys: 1, phrases: 0 },
  ];
  let data = await db.getData();
  assert.deepEqual(data.sessions[0].activity, measured);
  assert.equal(data.phrases.length, 0); assert.equal(data.attempts.length, 0);
  assert.equal(data.sessions[0].phraseCount, 0, 'uncertain physical volume does not invent a reliable OCR result');
  run.scene.prompt = false; run.scene.receipt = true;
  await run.observed(1520); await run.keys([[1600, ' '], [1700, 'z']]); await run.checkpoint();
  assert.equal((await run.app.request('UCHI_OFF_STOP')).ok, true);
  data = await db.getData(); assert.deepEqual(data.sessions[0].activity, measured);
  const summary = dailyTraining(data, { today: '2026-12-25', days: 2 });
  assert.equal(summary.totals.keys, 4); assert.equal(summary.totals.phrases, 1); assert.equal(summary.totals.activeMs, 700);
  assert.equal(summary.today.keys, 1); assert.equal(summary.totals.estimated, false);
});

test('each automatically separated game owns its activity and the daily total adds both games once', async () => {
  const run = await activityFixture(Date.parse('2026-12-25T03:00:00.000Z'));
  await run.keys([[20, ' ']]); run.scene.prompt = true;
  for (const at of [80, 160, 240, 320, 400, 480]) {
    if (at === 160) await run.keys([[100, 'a']]);
    if (at === 240) await run.keys([[200, 'b']]);
    await run.observed(at);
  }
  run.scene.prompt = false; run.scene.receipt = true; await run.observed(560);
  await run.keys([[600, ' '], [750, ' ']]);
  run.scene.prompt = true; run.scene.receipt = false;
  for (const at of [800, 880, 960, 1040]) {
    if (at === 880) await run.keys([[820, 'a']]);
    if (at === 960) await run.keys([[920, 'q']]);
    await run.observed(at);
  }
  run.scene.prompt = false; run.scene.receipt = true; await run.observed(1280);
  assert.equal((await run.app.request('UCHI_OFF_STOP')).ok, true);
  const data = await db.getData(); assert.equal(data.sessions.length, 2);
  assert.equal(data.sessions[0].id, 'startup-test'); assert.notEqual(data.sessions[1].id, data.sessions[0].id);
  for (const session of data.sessions) assert.deepEqual(session.activity, [{ date: '2026-12-25', activeMs: 100, keys: 2, phrases: 1 }]);
  assert.equal(data.sessions[0].endedAt, run.base + 560); assert.equal(data.sessions[1].startedAt, run.base + 800);
  const daily = dailyTraining(data, { today: '2026-12-25', days: 1 });
  assert.equal(daily.today.captureCount, 2); assert.equal(daily.today.keys, 4); assert.equal(daily.today.phrases, 2); assert.equal(daily.today.activeMs, 200);
});

test('focus, viewport and missing-frame gaps break capture input time without charging unknown intervals', async () => {
  const run = await activityFixture(); run.scene.prompt = true;
  for (const at of [80, 160, 240, 320]) {
    if (at === 160) await run.keys([[100, 'a']]);
    if (at === 240) await run.keys([[200, 'b']]);
    await run.observed(at);
  }
  await run.gap('UCHI_OFF_GAP', 330);
  for (const at of [400, 480, 560, 640, 720, 800]) {
    if (at === 640) await run.keys([[570, 'c']]);
    if (at === 720) await run.keys([[670, 'd']]);
    await run.observed(at);
  }
  await run.gap('UCHI_OFF_VIEW_CHANGE', 810);
  for (const at of [880, 960, 1040, 1120]) {
    if (at === 960) await run.keys([[900, 'e']]);
    if (at === 1040) await run.keys([[1000, 'f']]);
    await run.observed(at);
  }
  await run.keys([[1300, 'x']]); // The prompt was not observed during this gap.
  for (const at of [1520, 1600, 1680, 1760]) {
    if (at === 1600) await run.keys([[1540, 'g']]);
    if (at === 1680) await run.keys([[1640, 'h']]);
    await run.observed(at);
  }
  await run.checkpoint();
  assert.equal((await run.app.request('UCHI_OFF_STOP')).ok, true);
  const rows = (await db.getData()).sessions[0].activity!;
  assert.equal(rows.reduce((sum, row) => sum + row.keys, 0), 8);
  assert.equal(rows.reduce((sum, row) => sum + row.activeMs, 0), 400);
});
