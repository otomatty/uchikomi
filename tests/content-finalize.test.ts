import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

for (const failedDelivery of [false, true]) test(failedDelivery
  ? 'a rejected END is retried and cannot reuse the old capture session with a reset producer'
  : 'a fast visible return waits for final keys and the old END acknowledgement before starting another capture', async t => {
  const browser = new Window({ url: 'https://sushida.net/play.html' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of ['window', 'document', 'Element', 'HTMLCanvasElement']) define(name, name === 'window' ? browser : (browser as any)[name]);
  define('__uchikomiObserver', undefined);
  let onMessage: (message: any, sender: any, reply: (value: any) => void) => unknown;
  let owner: string | null = null, nextOwner = 0, tracks = 0, stoppedTracks = 0, nextTimer = 0;
  let releaseKeys: ((value: any) => void) | undefined, releaseEnd: ((value: any) => void) | undefined;
  let holdKeys = true, ending = false;
  let failEndDelivery = failedDelivery, failedEnds = 0;
  const messages: any[] = [];
  const request = (type: string) => onMessage?.({ type }, { id: 'finalize-test' }, () => {});
  define('chrome', { runtime: {
    id: 'finalize-test', getManifest: () => ({ version: '1.4.0' }),
    onMessage: { addListener(listener: typeof onMessage) { onMessage = listener; } },
    async sendMessage(message: any) {
      messages.push(message);
      if (message.type === 'UCHI_CANVAS_READY') {
        if (ending) return { ok: true, busy: true };
        // The real background returns the existing ID to the same document.
        owner ??= `capture-${++nextOwner}`;
        return { ok: true, sessionId: owner };
      }
      if (message.type === 'UCHI_CAPTURE_KEYS' && holdKeys) return new Promise(resolve => { releaseKeys = resolve; });
      if (message.type === 'UCHI_CANVAS_END') {
        assert.equal(message.sessionId, owner);
        if (failEndDelivery) { failedEnds++; throw new Error('The message port closed before delivery'); }
        ending = true;
        request('UCHI_CAPTURE_DISABLE');
        return new Promise(resolve => { releaseEnd = value => { owner = null; ending = false; resolve(value); }; });
      }
      return { ok: true };
    },
  } });
  Object.defineProperties(browser.document, {
    hasFocus: { configurable: true, value: () => true },
    visibilityState: { configurable: true, value: 'visible' },
  });
  Object.defineProperties(browser, {
    setInterval: { value: () => ++nextTimer }, clearInterval: { value: () => {} },
  });
  const create = browser.document.createElement.bind(browser.document);
  const canvas = create('canvas'); canvas.tabIndex = 0;
  Object.defineProperties(canvas, {
    getBoundingClientRect: { value: () => ({ width: 960, height: 800, left: 0, top: 0, right: 960, bottom: 800 }) },
    captureStream: { value: () => {
      tracks++;
      const track = new browser.EventTarget() as any;
      track.readyState = 'live'; track.muted = false;
      track.stop = () => { stoppedTracks++; track.readyState = 'ended'; };
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    } },
  });
  browser.document.body.append(canvas);
  Object.defineProperty(browser.document, 'createElement', { value: (name: string) => {
    const element = create(name as any);
    if (name === 'video') Object.defineProperties(element, {
      srcObject: { writable: true, value: null }, play: { value: async () => {} }, pause: { value: () => {} },
      requestVideoFrameCallback: { value: () => 1 }, cancelVideoFrameCallback: { value: () => {} },
    });
    if (name === 'canvas') Object.defineProperty(element, 'getContext', { value: () => ({ drawImage() {} }) });
    return element;
  } });
  const count = (type: string) => messages.filter(message => message.type === type).length;
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)); };
  const visibility = (value: 'hidden' | 'visible') => {
    Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value });
    browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  };
  const key = (value: string) => {
    canvas.focus();
    const event = new browser.KeyboardEvent('keydown', { key: value, code: `Key${value.toUpperCase()}`, bubbles: true });
    Object.defineProperty(event, 'isTrusted', { value: true }); canvas.dispatchEvent(event);
  };
  t.after(async () => {
    request('UCHI_CAPTURE_DISABLE'); releaseKeys?.({ ok: true }); releaseEnd?.({ ok: true });
    browser.dispatchEvent(new browser.Event('pagehide'));
    await browser.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  });
  await import(`../src/capture/content.ts?finalize-race=${failedDelivery}`); await settle();
  assert.equal(owner, 'capture-1'); assert.equal(tracks, 1);
  key('a'); visibility('hidden'); await settle();
  assert.ok(releaseKeys); assert.equal(count('UCHI_CANVAS_END'), 0); assert.equal(stoppedTracks, 1);
  visibility('visible'); request('UCHI_CANVAS_PROBE'); request('UCHI_CANVAS_PROBE'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 1, 'returning during the final key ACK cannot reclaim the ending session');
  assert.equal(tracks, 1);
  holdKeys = false; releaseKeys!({ ok: true }); await settle();
  if (failedDelivery) {
    assert.ok(failedEnds > 0);
    assert.equal(releaseEnd, undefined);
    assert.equal(owner, 'capture-1'); assert.equal(tracks, 1);
    assert.equal(count('UCHI_CANVAS_READY'), 1, 'A rejected END must not release the finalization barrier');
    const attempts = failedEnds;
    request('UCHI_CANVAS_PROBE'); await settle();
    assert.ok(failedEnds > attempts, 'Rediscovery retries the same END before requesting a session');
    assert.equal(count('UCHI_CANVAS_READY'), 1); assert.equal(tracks, 1);
    failEndDelivery = false;
    request('UCHI_CANVAS_PROBE'); await settle();
  }
  assert.ok(releaseEnd); assert.equal(count('UCHI_CANVAS_END') - failedEnds, 1);
  request('UCHI_CANVAS_PROBE'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 1, 'the END acknowledgement is also part of the barrier');
  releaseEnd!({ ok: true }); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 2); assert.equal(owner, 'capture-2'); assert.equal(tracks, 2);
  // A second hide while waiting must win over the earlier visible request.
  holdKeys = true; releaseKeys = releaseEnd = undefined;
  key('b'); visibility('hidden'); await settle();
  visibility('visible'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 2);
  holdKeys = false; releaseKeys!({ ok: true }); await settle();
  assert.ok(releaseEnd);
  visibility('hidden'); releaseEnd!({ ok: true }); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 2, 'the current visibility is rechecked after END completes');
  assert.equal(owner, null); assert.equal(tracks, 2);
  visibility('visible'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 3); assert.equal(owner, 'capture-3'); assert.equal(tracks, 3);
  key('c'); request('UCHI_CAPTURE_DISABLE'); await settle();
  assert.deepEqual(messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS').map(message => [message.sessionId, message.keys.map((stroke: any) => stroke.key)]), [
    ['capture-1', ['a']], ['capture-2', ['b']], ['capture-3', ['c']],
  ]);
  assert.equal(count('UCHI_CANVAS_END') - failedEnds, 2, 'coalesced probes do not end or duplicate the new subscription');
});
