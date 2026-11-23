import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createCanvasProducer, visibleGameCanvas, type CanvasFrame } from '../src/capture/canvas-producer';

function fixture() {
  const browser = new Window({ url: 'https://sushida.net/play.html' });
  const document = browser.document;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const source = document.createElement('canvas');
  document.body.append(source);
  Object.defineProperty(source, 'getBoundingClientRect', { value: () => ({ width: 960, height: 800, left: 0, top: 0, right: 960, bottom: 800 }) });
  const video = document.createElement('video');
  const image = document.createElement('canvas');
  const callbacks = new Map<number, (now: number, metadata: any) => void>();
  const intervals = new Map<number, () => void>();
  const draws: unknown[][] = [];
  const track = new browser.EventTarget() as any;
  let stopped = 0;
  let paused = 0;
  let nextId = 0;
  track.muted = false;
  track.readyState = 'live';
  track.stop = () => { stopped++; track.readyState = 'ended'; };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  Object.defineProperty(source, 'captureStream', { configurable: true, value: (fps: number) => { assert.equal(fps, 15); return stream; } });
  Object.defineProperties(video, {
    srcObject: { configurable: true, writable: true, value: null },
    play: { configurable: true, value: async () => {} },
    pause: { value: () => { paused++; } },
    readyState: { value: 4 }, videoWidth: { value: 3840 }, videoHeight: { value: 3200 },
    requestVideoFrameCallback: { value: (callback: any) => { const id = ++nextId; callbacks.set(id, callback); return id; } },
    cancelVideoFrameCallback: { value: (id: number) => callbacks.delete(id) },
  });
  Object.defineProperty(image, 'getContext', { value: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }) });
  Object.defineProperty(image, 'toDataURL', { value: (type: string, quality: number) => { assert.equal(type, 'image/jpeg'); assert.equal(quality, .92); return 'data:image/jpeg;base64,AAAA'; } });
  const originalCreate = document.createElement.bind(document);
  Object.defineProperty(document, 'createElement', { value: (name: string) => name === 'video' ? video : name === 'canvas' ? image : originalCreate(name) });
  Object.defineProperties(browser, {
    setInterval: { value: (fn: () => void, ms: number) => { assert.equal(ms, 80); const id = ++nextId; intervals.set(id, fn); return id; } },
    clearInterval: { value: (id: number) => intervals.delete(id) },
  });
  return {
    browser, document, source, video, image, track, draws, callbacks, intervals,
    stopped: () => stopped, paused: () => paused,
    tick() { for (const fn of intervals.values()) fn(); },
    frame(count: number, now = count * 80) {
      const entry = callbacks.entries().next().value;
      assert.ok(entry);
      callbacks.delete(entry[0]);
      entry[1](now, { presentedFrames: count });
    },
  };
}

test('canvas capture samples only fresh frames, bounds image size and waits for acknowledgement', async t => {
  const f = fixture();
  t.after(() => f.browser.happyDOM.close());
  const frames: CanvasFrame[] = [];
  let acknowledge: (() => void) | undefined;
  const producer = createCanvasProducer(f.source as any, {
    onFrame(frame) { frames.push(frame); return new Promise(resolve => { acknowledge = resolve; }); },
    onError(error) { throw error; },
  });
  t.after(() => producer.stop());
  await producer.ready;
  assert.equal(f.video.muted, true);
  assert.equal(f.video.isConnected, false);
  assert.equal(f.document.body.children.length, 1);
  f.tick();
  assert.equal(frames.length, 0, 'no still image is invented before a presented frame');
  f.frame(1); f.tick();
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].width, frames[0].height], [1728, 1440]);
  assert.equal(frames[0].sequence, 1);
  assert.equal(frames[0].at, f.browser.performance.timeOrigin + 80);
  assert.equal(f.draws[0][0], f.video, 'read the painted video, never the WebGL source canvas');
  f.frame(2); f.tick(); f.frame(3); f.tick();
  assert.equal(frames.length, 1, 'one frame may be in flight');
  acknowledge!(); await Promise.resolve();
  f.tick();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].sequence, 2);
  assert.equal(frames[1].at, f.browser.performance.timeOrigin + 240);
  acknowledge!(); await Promise.resolve();
  f.tick(); f.tick();
  assert.equal(frames.length, 2, 'a frozen source never becomes repeated OCR evidence');
  producer.stop(); producer.stop();
  assert.equal(f.stopped(), 1);
  assert.equal(f.paused(), 1);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.video.srcObject, null);
});

test('a muted canvas or lost WebGL context stops capture once without changing the game', async t => {
  for (const kind of ['mute', 'ended', 'webglcontextlost']) {
    const f = fixture();
    t.after(() => f.browser.happyDOM.close());
    const errors: Error[] = [];
    const producer = createCanvasProducer(f.source as any, { async onFrame() {}, onError: error => errors.push(error) });
    await producer.ready;
    const target = kind === 'webglcontextlost' ? f.source : f.track;
    const event = new f.browser.Event(kind, { cancelable: true });
    target.dispatchEvent(event); target.dispatchEvent(new f.browser.Event(kind));
    assert.equal(errors.length, 1);
    assert.equal(f.stopped(), 1);
    assert.equal(event.defaultPrevented, false, 'do not intercept the game context recovery');
    assert.equal(f.intervals.size, 0);
  }
});

test('origin-clean and autoplay errors fail closed and release any allocated stream', async t => {
  const denied = fixture();
  t.after(() => denied.browser.happyDOM.close());
  Object.defineProperty(denied.source, 'captureStream', { value: () => { throw new DOMException('Tainted canvas', 'SecurityError'); } });
  assert.throws(() => createCanvasProducer(denied.source as any, { async onFrame() {}, onError() {} }), { name: 'SecurityError' });

  const rejected = fixture();
  t.after(() => rejected.browser.happyDOM.close());
  Object.defineProperty(rejected.video, 'play', { value: async () => { throw new DOMException('Playback denied', 'NotAllowedError'); } });
  const producer = createCanvasProducer(rejected.source as any, { async onFrame() {}, onError() {} });
  await assert.rejects(producer.ready, { name: 'NotAllowedError' });
  assert.equal(rejected.stopped(), 1);
  assert.equal(rejected.video.srcObject, null);
});

test('canvas discovery ignores hidden, offscreen and small surfaces', async t => {
  const f = fixture();
  t.after(() => f.browser.happyDOM.close());
  assert.equal(visibleGameCanvas(f.document as any), f.source);
  f.document.body.style.opacity = '0';
  assert.equal(visibleGameCanvas(f.document as any), null);
  f.document.body.style.opacity = '1';
  f.source.style.display = 'none';
  assert.equal(visibleGameCanvas(f.document as any), null);
  f.source.style.display = 'block';
  Object.defineProperty(f.document, 'visibilityState', { value: 'hidden' });
  assert.equal(visibleGameCanvas(f.document as any), null);
});
