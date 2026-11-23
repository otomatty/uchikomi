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
  const timeouts = new Map<number, () => void>();
  const draws: unknown[][] = [];
  const track = new browser.EventTarget() as any;
  let stopped = 0;
  let paused = 0;
  let nextId = 0;
  let videoPixels = 'initial', encodedPixels = 'initial';
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
  Object.defineProperty(image, 'getContext', { value: () => ({ drawImage: (...args: unknown[]) => { draws.push(args); encodedPixels = videoPixels; } }) });
  Object.defineProperty(image, 'toDataURL', { value: (type: string, quality: number) => { assert.equal(type, 'image/jpeg'); assert.equal(quality, .92); return `data:image/jpeg;base64,${Buffer.from(encodedPixels).toString('base64')}`; } });
  const originalCreate = document.createElement.bind(document);
  Object.defineProperty(document, 'createElement', { value: (name: string) => name === 'video' ? video : name === 'canvas' ? image : originalCreate(name) });
  Object.defineProperties(browser, {
    setInterval: { value: (fn: () => void, ms: number) => { assert.equal(ms, 80); const id = ++nextId; intervals.set(id, fn); return id; } },
    clearInterval: { value: (id: number) => intervals.delete(id) },
    setTimeout: { value: (fn: () => void, ms: number) => { assert.equal(ms, 10000); const id = ++nextId; timeouts.set(id, fn); return id; } },
    clearTimeout: { value: (id: number) => timeouts.delete(id) },
  });
  return {
    browser, document, source, video, image, track, draws, callbacks, intervals, timeouts,
    stopped: () => stopped, paused: () => paused,
    setVideoPixels: (pixels: string) => { videoPixels = pixels; },
    tick() { for (const fn of intervals.values()) fn(); },
    timeout() { for (const [id, fn] of timeouts) { timeouts.delete(id); fn(); } },
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
  assert.equal(frames[1].sequence, 3, 'Only the latest snapshot is retained while waiting for the ACK');
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

test('video fallback snapshots pixels with their presentation timestamp before a later timer tick', async t => {
  const f = fixture(); t.after(() => f.browser.happyDOM.close());
  const frames: CanvasFrame[] = [];
  const producer = createCanvasProducer(f.source as any, { async onFrame(frame) { frames.push(frame); }, onError(error) { throw error; } });
  t.after(() => producer.stop()); await producer.ready;
  f.setVideoPixels('frame A'); f.frame(1, 80);
  f.setVideoPixels('frame B'); // Playback advances before its next callback is delivered.
  f.tick(); await settleFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].dataUrl, `data:image/jpeg;base64,${Buffer.from('frame A').toString('base64')}`);
  assert.equal(frames[0].at, f.browser.performance.timeOrigin + 80);
  f.frame(2, 160); f.tick(); await settleFrames();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].dataUrl, `data:image/jpeg;base64,${Buffer.from('frame B').toString('base64')}`);
  assert.equal(frames[1].at, f.browser.performance.timeOrigin + 160);
  f.frame(2, 240); f.tick(); await settleFrames();
  assert.equal(frames.length, 2, 'The same presented frame cannot become independent evidence at a new time');
});

function trackFixture() {
  const f = fixture();
  let pending: { resolve: (value: any) => void; reject: (error: unknown) => void } | undefined;
  let reads = 0, cancelled = 0, released = 0;
  const reader = {
    read() { reads++; return new Promise<any>((resolve, reject) => { pending = { resolve, reject }; }); },
    async cancel() { cancelled++; pending?.resolve({ done: true }); pending = undefined; },
    releaseLock() { released++; },
  };
  Object.defineProperty(f.browser, 'MediaStreamTrackProcessor', { value: class {
    readable = { getReader: () => reader };
    constructor(options: any) { assert.equal(options.track, f.track); assert.equal(options.maxBufferSize, 1); }
  } });
  return {
    ...f,
    reads: () => reads, cancelled: () => cancelled, released: () => released,
    deliver(timestamp: number) {
      assert.ok(pending, 'The producer must be waiting for an actual source frame');
      let closed = 0;
      const frame = { timestamp, displayWidth: 3840, displayHeight: 3200, close() { closed++; } };
      const waiting = pending; pending = undefined; waiting.resolve({ value: frame, done: false });
      return { frame, closed: () => closed };
    },
  };
}
const settleFrames = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('track frames arrive without video playback, close before acknowledgement and reject repeated timestamps', async t => {
  const f = trackFixture();
  t.after(() => f.browser.happyDOM.close());
  const frames: CanvasFrame[] = [];
  let acknowledge!: () => void;
  const producer = createCanvasProducer(f.source as any, {
    onFrame(frame) { frames.push(frame); return new Promise(resolve => { acknowledge = resolve; }); },
    onError(error) { throw error; },
  });
  t.after(() => producer.stop());
  await producer.ready;
  assert.equal(f.reads(), 1); assert.equal(f.callbacks.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.document.body.children.length, 1, 'No media element or overlay is added to the game');
  assert.equal(f.video.srcObject, null, 'The track processor does not require playback');
  const first = f.deliver(100000); await settleFrames();
  assert.equal(frames.length, 1); assert.equal(first.closed(), 1, 'Release the VideoFrame before waiting for the networkless message');
  assert.equal(f.draws[0][0], first.frame, 'Encode the received VideoFrame, never the WebGL backbuffer');
  assert.deepEqual([frames[0].width, frames[0].height], [1728, 1440]);
  assert.ok(Math.abs(frames[0].at - Date.now()) < 1000);
  assert.equal(f.reads(), 1, 'Only one JPEG may be in flight');
  acknowledge(); await settleFrames();
  assert.equal(f.timeouts.size, 0);
  const repeated = f.deliver(100000); await settleFrames();
  assert.equal(repeated.closed(), 1); assert.equal(frames.length, 1, 'A repeated source timestamp is not fresh evidence');
  const next = f.deliver(180000); await settleFrames();
  assert.equal(next.closed(), 1); assert.equal(frames.length, 2); assert.equal(frames[1].sequence, 2);
  acknowledge(); await settleFrames();
  producer.stop(); producer.stop(); await settleFrames();
  assert.equal(f.cancelled(), 1); assert.equal(f.released(), 1); assert.equal(f.stopped(), 1);
  assert.equal(f.paused(), 0);
});

test('stopping a pending track read closes a late frame without sending it', async t => {
  const f = trackFixture(); t.after(() => f.browser.happyDOM.close());
  const frames: CanvasFrame[] = [];
  const producer = createCanvasProducer(f.source as any, { async onFrame(frame) { frames.push(frame); }, onError(error) { throw error; } });
  await producer.ready;
  const late = f.deliver(100000);
  producer.stop(); await settleFrames();
  assert.equal(late.closed(), 1); assert.equal(frames.length, 0);
  assert.equal(f.cancelled(), 1); assert.equal(f.released(), 1); assert.equal(f.stopped(), 1);
});

test('a failed frame acknowledgement releases the reader and reports the failure once', async t => {
  const f = trackFixture(); t.after(() => f.browser.happyDOM.close());
  const errors: Error[] = [];
  const producer = createCanvasProducer(f.source as any, {
    async onFrame() { throw new Error('Offscreen unavailable'); }, onError(error) { errors.push(error); },
  });
  await producer.ready;
  const frame = f.deliver(100000); await settleFrames();
  assert.equal(frame.closed(), 1); assert.equal(errors.length, 1); assert.equal(errors[0].message, 'Offscreen unavailable');
  assert.equal(f.cancelled(), 1); assert.equal(f.released(), 1); assert.equal(f.stopped(), 1);
});

test('a suspended video or a silent source times out, and stopping cancels pending startup', async t => {
  for (const processor of [false, true]) {
    const f = processor ? trackFixture() : fixture(); t.after(() => f.browser.happyDOM.close());
    const errors: Error[] = [];
    const producer = createCanvasProducer(f.source as any, { async onFrame() {}, onError(error) { errors.push(error); } });
    await producer.ready;
    f.timeout(); await settleFrames();
    assert.equal(errors.length, 1); assert.match(errors[0].message, /ゲーム画面を読み取れません/);
    assert.equal(f.stopped(), 1); assert.equal(f.timeouts.size, 0);
  }
  const f = fixture(); t.after(() => f.browser.happyDOM.close());
  Object.defineProperty(f.video, 'play', { value: () => new Promise(() => {}) });
  const producer = createCanvasProducer(f.source as any, { async onFrame() {}, onError(error) { throw error; } });
  producer.stop(); await producer.ready;
  assert.equal(f.stopped(), 1); assert.equal(f.timeouts.size, 0);
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

test('canvas discovery intersects clipping ancestors and admits the same canvas when it becomes partially visible', async t => {
  const f = fixture(); t.after(() => f.browser.happyDOM.close());
  const wrapper = f.document.createElement('div');
  let bounds = { width: 300, height: 200, left: 980, top: 0, right: 1280, bottom: 200 };
  Object.defineProperty(wrapper, 'getBoundingClientRect', { value: () => bounds });
  wrapper.style.overflow = 'hidden';
  f.document.body.append(wrapper); wrapper.append(f.source);
  assert.equal(visibleGameCanvas(f.document as any), null, 'The canvas viewport rectangle alone is insufficient');
  bounds = { ...bounds, left: 800, right: 1100 };
  assert.equal(visibleGameCanvas(f.document as any), f.source, 'A partially visible canvas remains eligible');
  bounds = { ...bounds, top: 810, bottom: 1010 };
  assert.equal(visibleGameCanvas(f.document as any), null);
  wrapper.style.overflow = 'visible';
  wrapper.style.overflowX = 'clip'; wrapper.style.overflowY = 'visible';
  assert.equal(visibleGameCanvas(f.document as any), f.source, 'Only the clipped axis constrains the visible intersection');
  wrapper.style.contain = 'paint';
  assert.equal(visibleGameCanvas(f.document as any), null, 'Paint containment also clips both axes');
});

test('absolute canvases escape intermediate overflow but remain clipped by their containing block', async t => {
  const f = fixture(); t.after(() => f.browser.happyDOM.close());
  const containingBlock = f.document.createElement('div'), wrapper = f.document.createElement('div');
  const outside = { width: 300, height: 200, left: 980, top: 0, right: 1280, bottom: 200 };
  for (const element of [containingBlock, wrapper]) Object.defineProperty(element, 'getBoundingClientRect', { value: () => outside });
  containingBlock.style.position = 'relative'; wrapper.style.overflow = 'hidden'; f.source.style.position = 'absolute';
  f.document.body.append(containingBlock); containingBlock.append(wrapper); wrapper.append(f.source);
  assert.equal(visibleGameCanvas(f.document as any) === f.source, true, 'A static wrapper between an absolute canvas and its containing block does not clip it');
  wrapper.style.position = 'relative';
  assert.equal(visibleGameCanvas(f.document as any), null, 'The same wrapper clips once it establishes the containing block');
  wrapper.style.position = 'static'; containingBlock.style.overflow = 'hidden';
  assert.equal(visibleGameCanvas(f.document as any), null, 'Overflow on the actual containing block still applies');
});

test('fixed canvases escape positioned overflow until a transform or containment establishes their containing block', async t => {
  const f = fixture(); t.after(() => f.browser.happyDOM.close());
  const wrapper = f.document.createElement('div');
  Object.defineProperty(wrapper, 'getBoundingClientRect', { value: () => ({ width: 300, height: 200, left: 980, top: 0, right: 1280, bottom: 200 }) });
  wrapper.style.position = 'relative'; wrapper.style.overflow = 'hidden'; f.source.style.position = 'fixed';
  f.document.body.append(wrapper); wrapper.append(f.source);
  assert.equal(visibleGameCanvas(f.document as any) === f.source, true, 'Position alone cannot contain a fixed canvas');
  wrapper.style.transform = 'translateX(0px)';
  assert.equal(visibleGameCanvas(f.document as any), null, 'A transform makes the ancestor overflow applicable');
  wrapper.style.transform = 'none'; wrapper.style.contain = 'layout';
  assert.equal(visibleGameCanvas(f.document as any), null, 'Layout containment also establishes the fixed containing block');
  wrapper.style.overflow = 'visible'; wrapper.style.contain = 'paint';
  assert.equal(visibleGameCanvas(f.document as any), null, 'Paint containment cannot be bypassed');
});

test('an in-flow canvas inherits its positioned ancestor escape from an intermediate overflow wrapper', async t => {
  const f = fixture(); t.after(() => f.browser.happyDOM.close());
  const containingBlock = f.document.createElement('div'), wrapper = f.document.createElement('div'), positioned = f.document.createElement('div');
  Object.defineProperty(wrapper, 'getBoundingClientRect', { value: () => ({ width: 300, height: 200, left: 980, top: 0, right: 1280, bottom: 200 }) });
  containingBlock.style.position = 'relative'; wrapper.style.overflow = 'hidden';
  f.document.body.append(containingBlock); containingBlock.append(wrapper); wrapper.append(positioned); positioned.append(f.source);
  for (const position of ['absolute', 'fixed']) {
    positioned.style.position = position;
    assert.equal(visibleGameCanvas(f.document as any) === f.source, true, `The ${position} ancestor and its in-flow contents escape together`);
  }
  positioned.style.position = 'static';
  assert.equal(visibleGameCanvas(f.document as any), null, 'Ordinary in-flow contents remain clipped');
});
