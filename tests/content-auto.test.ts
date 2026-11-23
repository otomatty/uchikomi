import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

test('a visible game starts itself, resumes after visibility, and respects pause, failures and stale starts', async t => {
  const browser = new Window({ url: 'https://sushida.net/play.html' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of ['window', 'document', 'Element', 'HTMLCanvasElement']) define(name, name === 'window' ? browser : (browser as any)[name]);
  define('__uchikomiObserver', true); // A previous manual-only extension was already injected.
  const messages: any[] = [];
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  const tracks: any[] = [];
  const stops: number[] = [];
  let nextTimer = 0;
  let mode: 'pending' | 'ready' | 'paused' = 'pending';
  let completeReady: ((response: unknown) => void) | undefined;
  let nextSession = 0;
  let onMessage: ((message: any, sender: any, respond: (value: any) => void) => unknown) | undefined;
  define('chrome', { runtime: {
    id: 'auto-test',
    getManifest: () => ({ version: '1.4.0' }),
    async sendMessage(message: any) {
      messages.push(message);
      if (message.type === 'UCHI_CANVAS_READY') {
        if (mode === 'pending') return await new Promise(resolve => { completeReady = resolve; });
        return mode === 'paused' ? { ok: true, paused: true } : { ok: true, sessionId: `auto-${++nextSession}` };
      }
      return { ok: true };
    },
    onMessage: { addListener(listener: typeof onMessage) { onMessage = listener; } },
  } });
  Object.defineProperty(browser.document, 'hasFocus', { configurable: true, value: () => true });
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperties(browser, {
    setInterval: { value: (callback: () => void, ms: number) => { const id = ++nextTimer; intervals.set(id, { callback, ms }); return id; } },
    clearInterval: { value: (id: number) => intervals.delete(id) },
  });
  const create = browser.document.createElement.bind(browser.document);
  const makeCanvas = () => {
    const canvas = create('canvas'); canvas.tabIndex = 0;
    Object.defineProperties(canvas, {
      getBoundingClientRect: { value: () => ({ width: 960, height: 800, left: 0, top: 0, right: 960, bottom: 800 }) },
      captureStream: { value: () => {
        const index = tracks.length;
        const track = new browser.EventTarget() as any;
        track.readyState = 'live'; track.muted = false;
        track.stop = () => { stops[index] = (stops[index] ?? 0) + 1; track.readyState = 'ended'; };
        tracks.push(track);
        return { getVideoTracks: () => [track], getTracks: () => [track] };
      } },
    });
    return canvas;
  };
  Object.defineProperty(browser.document, 'createElement', { value: (name: string) => {
    const element = create(name as any);
    if (name === 'video') Object.defineProperties(element, {
      srcObject: { writable: true, value: null }, play: { value: async () => {} }, pause: { value: () => {} },
      requestVideoFrameCallback: { value: () => 1 }, cancelVideoFrameCallback: { value: () => {} },
    });
    if (name === 'canvas') Object.defineProperty(element, 'getContext', { value: () => ({ drawImage() {} }) });
    return element;
  } });
  const initialCanvas = makeCanvas(); browser.document.body.append(initialCanvas);
  const request = (type: string, extra: object = {}) => onMessage?.({ type, ...extra }, { id: 'auto-test' }, () => {});
  const count = (type: string) => messages.filter(message => message.type === type).length;
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)); };
  const visibility = (value: 'visible' | 'hidden') => {
    Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value });
    browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  };
  t.after(async () => {
    browser.dispatchEvent(new browser.Event('pagehide'));
    await browser.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  });
  await import('../src/capture/content');
  await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 1, 'opening the game requests recording without a button');
  request('UCHI_CANVAS_PROBE'); request('UCHI_CANVAS_PROBE');
  assert.equal(count('UCHI_CANVAS_READY'), 1, 'a pending start is not duplicated');
  mode = 'ready'; completeReady!({ ok: true, sessionId: 'initial' }); await settle();
  assert.equal(tracks.length, 1);
  assert.equal(count('UCHI_CANVAS_READY'), 1);
  const token = messages[0].documentToken;
  assert.match(token, /^[a-f0-9-]{36}$/);
  await import('../src/capture/content.ts?reinjection=automatic'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 1, 'reinjection of this observer version is idempotent');

  initialCanvas.focus();
  const key = new browser.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true });
  Object.defineProperty(key, 'isTrusted', { value: true });
  initialCanvas.dispatchEvent(key);
  visibility('hidden'); await settle();
  assert.equal(stops[0], 1);
  assert.equal(messages.find(message => message.type === 'UCHI_CAPTURE_KEYS').documentToken, token);
  assert.equal(messages.find(message => message.type === 'UCHI_CAPTURE_GAP').documentToken, token);
  assert.equal(messages.find(message => message.type === 'UCHI_CANVAS_END').reason, 'hidden');
  request('UCHI_CANVAS_PROBE'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 1, 'hidden documents never start');
  visibility('visible'); await settle();
  assert.equal(tracks.length, 2);

  mode = 'paused'; request('UCHI_CAPTURE_DISABLE'); request('UCHI_CANVAS_PROBE'); await settle();
  assert.equal(stops[1], 1);
  assert.equal(tracks.length, 2, 'a manual pause cannot be undone by automatic discovery');
  mode = 'ready'; request('UCHI_CANVAS_PROBE'); await settle();
  assert.equal(tracks.length, 3);
  tracks[2].dispatchEvent(new browser.Event('mute')); await settle();
  assert.equal(stops[2], 1);
  assert.equal(messages.filter(message => message.type === 'UCHI_CANVAS_END').at(-1).reason, 'error');
  const beforeRetry = count('UCHI_CANVAS_READY');
  for (const { callback, ms } of intervals.values()) if (ms === 2500) callback();
  await settle();
  assert.equal(count('UCHI_CANVAS_READY'), beforeRetry, 'capture failures do not cause an automatic retry loop');
  request('UCHI_CANVAS_PROBE'); await settle();
  assert.equal(tracks.length, 4);

  initialCanvas.remove(); await settle();
  assert.equal(stops[3], 1);
  assert.equal(messages.filter(message => message.type === 'UCHI_CANVAS_END').at(-1).reason, 'removed');
  const replacement = makeCanvas(); browser.document.body.append(replacement); await settle();
  assert.equal(tracks.length, 5, 'a replacement canvas is discovered');
  assert.ok(messages.filter(message => message.documentToken).every(message => message.documentToken === token));

  visibility('hidden'); await settle();
  mode = 'pending'; visibility('visible'); await settle();
  visibility('hidden'); completeReady!({ ok: true, sessionId: 'late-reply' }); await settle();
  assert.equal(tracks.length, 5, 'a late start reply cannot record a hidden document');
  assert.ok(messages.some(message => message.type === 'UCHI_CANVAS_END' && message.sessionId === 'late-reply' && message.reason === 'hidden'));

  visibility('visible'); await settle();
  request('UCHI_CAPTURE_ENABLE', { sessionId: 'manual-fallback' });
  completeReady!({ ok: true, sessionId: 'stale-canvas' }); await settle();
  assert.equal(tracks.length, 5, 'manual fallback invalidates a pending automatic start');
  assert.ok(messages.some(message => message.type === 'UCHI_CANVAS_END' && message.sessionId === 'stale-canvas'));
  const readyBeforeManualHide = count('UCHI_CANVAS_READY');
  visibility('hidden'); visibility('visible'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), readyBeforeManualHide, 'manual capture retains its subscription on visibility changes');
  assert.equal(messages.some(message => message.type === 'UCHI_CANVAS_END' && message.sessionId === 'manual-fallback'), false);
  replacement.focus();
  const resumedKey = new browser.KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true });
  Object.defineProperty(resumedKey, 'isTrusted', { value: true });
  replacement.dispatchEvent(resumedKey);
  request('UCHI_CAPTURE_DISABLE');
  const manualKeys = messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS' && message.sessionId === 'manual-fallback').flatMap(message => message.keys.map((stroke: any) => stroke.key));
  assert.deepEqual(manualKeys, ['b']);
});
