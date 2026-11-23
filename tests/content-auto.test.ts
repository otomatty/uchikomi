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
  let allowReplay = true, holdReplay = false;
  let finishReplay: ((reply: any) => void) | undefined;
  let endFailures = 0;
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
      if (message.type === 'UCHI_CAPTURE_REPLAY') {
        if (holdReplay) return new Promise(resolve => { finishReplay = resolve; });
        return { ok: true, ready: allowReplay, sessionId: message.sessionId };
      }
      if (message.type === 'UCHI_CANVAS_END' && endFailures > 0) { endFailures--; throw new Error('END delivery failed'); }
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
  const request = (type: string, extra: object = {}) => { let reply: unknown; onMessage?.({ type, ...extra }, { id: 'auto-test' }, value => { reply = value; }); return reply; };
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
  request('UCHI_REPLAY_SETTINGS', { sessionId: 'initial', replayShortcut: 'F2' });
  mode = 'ready'; completeReady!({ ok: true, sessionId: 'initial', replayShortcut: 'Escape' }); await settle();
  assert.equal(tracks.length, 1);
  assert.equal(count('UCHI_CANVAS_READY'), 1);
  const token = messages[0].documentToken;
  assert.match(token, /^[a-f0-9-]{36}$/);
  assert.deepEqual(request('UCHI_CANVAS_CHECK', { documentToken: token }), { ok: true, documentToken: token });
  assert.equal(request('UCHI_CANVAS_CHECK', { documentToken: 'another-document-token' }), undefined);
  await import('../src/capture/content.ts?reinjection=automatic'); await settle();
  assert.equal(count('UCHI_CANVAS_READY'), 1, 'reinjection of this observer version is idempotent');

  initialCanvas.focus();
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const escapes: { type: string; trusted: boolean; keyCode: number }[] = [];
  for (const type of ['keydown', 'keyup']) initialCanvas.addEventListener(type, (event: any) => {
    if (event.key === 'Escape') escapes.push({ type, trusted: event.isTrusted === true, keyCode: event.keyCode });
  });
  const press = (key: string, code = key, extra: any = {}, target: any = initialCanvas) => {
    const event = new browser.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra });
    Object.defineProperty(event, 'isTrusted', { value: extra.isTrusted ?? true });
    target.dispatchEvent(event); return event;
  };
  assert.equal(press('Escape').defaultPrevented, false, 'The native replay key must pass unchanged');
  assert.equal(count('UCHI_CAPTURE_REPLAY'), 0);
  assert.deepEqual(escapes.map(event => event.trusted), [true]);
  allowReplay = false;
  assert.equal(press('F2').defaultPrevented, true, 'The preference notification received during startup wins over the stale READY value');
  await settle(); assert.equal(count('UCHI_CAPTURE_REPLAY'), 1);
  assert.equal(escapes.length, 1, 'A non-result response still grants no synthetic key');
  allowReplay = true;
  request('UCHI_REPLAY_SETTINGS', { sessionId: 'initial', replayShortcut: 'Shift+Enter' });
  press('F2'); press('Enter', 'Enter', { shiftKey: true, ctrlKey: true });
  press('Enter', 'Enter', { shiftKey: true, repeat: true });
  press('Enter', 'Enter', { shiftKey: true, isTrusted: false });
  await settle(); assert.equal(count('UCHI_CAPTURE_REPLAY'), 1);
  assert.equal(press('Enter', 'Enter', { shiftKey: true }).defaultPrevented, true);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(count('UCHI_CAPTURE_REPLAY'), 2);
  assert.deepEqual(escapes.slice(1).map(event => [event.type, event.trusted, event.keyCode]), [['keydown', false, 27], ['keyup', false, 27]]);
  assert.equal(messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS').flatMap(message => message.keys).length, 0,
    'A replay shortcut and its synthetic Escape never become typing measurements');
  clock += 1500; allowReplay = false;
  press('Enter', 'Enter', { shiftKey: true }); await settle();
  assert.equal(count('UCHI_CAPTURE_REPLAY'), 3); assert.equal(escapes.length, 3, 'A non-result/stale screen grants no key');
  request('UCHI_REPLAY_SETTINGS', { sessionId: 'another-capture', replayShortcut: 'F2' });
  press('F2'); await settle(); assert.equal(count('UCHI_CAPTURE_REPLAY'), 3, 'A stale capture cannot change the selected key');
  const input = create('input'); browser.document.body.append(input); input.focus();
  press('Enter', 'Enter', { shiftKey: true }, input); await settle();
  assert.equal(count('UCHI_CAPTURE_REPLAY'), 3, 'Editing a field cannot trigger game actions');
  input.remove(); initialCanvas.focus();
  request('UCHI_REPLAY_SETTINGS', { sessionId: 'initial', replayShortcut: 'F2' });
  holdReplay = true; allowReplay = true;
  press('F2'); await settle(); assert.ok(finishReplay);
  press('Process', 'KeyA', { isComposing: true, keyCode: 229 });
  finishReplay!({ ok: true, ready: true, sessionId: 'initial' }); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(escapes.length, 3, 'Starting IME while permission is pending must cancel the replay');
  const key = new browser.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true });
  Object.defineProperty(key, 'isTrusted', { value: true });
  initialCanvas.dispatchEvent(key);
  finishReplay = undefined;
  const beforeHiddenReplay = count('UCHI_CAPTURE_REPLAY');
  press('F2'); await settle(); assert.ok(finishReplay);
  assert.equal(count('UCHI_CAPTURE_REPLAY'), beforeHiddenReplay + 1, 'The visibility case must exercise a new pending request');
  visibility('hidden'); await settle();
  assert.deepEqual(request('UCHI_CANVAS_CHECK', { documentToken: token }), { ok: false, documentToken: token });
  finishReplay!({ ok: true, ready: true, sessionId: 'initial' }); await settle();
  assert.equal(escapes.length, 3, 'A late permission cannot replay a hidden or replaced capture');
  holdReplay = false;
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
  endFailures = 1;
  tracks[2].dispatchEvent(new browser.Event('mute')); await settle();
  assert.equal(stops[2], 1);
  assert.equal(messages.filter(message => message.type === 'UCHI_CANVAS_END').at(-1).reason, 'error');
  const beforeRetry = count('UCHI_CANVAS_READY');
  const beforeEndRetry = count('UCHI_CANVAS_END');
  for (const { callback, ms } of intervals.values()) if (ms === 2500) callback();
  await settle();
  assert.equal(count('UCHI_CANVAS_END'), beforeEndRetry + 1, 'A producer error still retries the failed release on the periodic probe');
  assert.equal(count('UCHI_CANVAS_READY'), beforeRetry, 'capture failures do not cause an automatic retry loop');
  for (const { callback, ms } of intervals.values()) if (ms === 2500) callback();
  await settle();
  assert.equal(count('UCHI_CANVAS_END'), beforeEndRetry + 1, 'The release is acknowledged once');
  assert.equal(count('UCHI_CANVAS_READY'), beforeRetry, 'An END acknowledgement alone does not permit another recording');
  request('UCHI_CANVAS_PROBE'); await settle();
  assert.equal(tracks.length, 4);

  initialCanvas.remove(); await settle();
  assert.equal(stops[3], 1);
  assert.equal(messages.filter(message => message.type === 'UCHI_CANVAS_END').at(-1).reason, 'removed');
  assert.equal(request('UCHI_CAPTURE_ENABLE', { sessionId: 'not-the-game-frame' }), undefined,
    'A frame without a visible canvas cannot claim manual replay ownership');
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
  replacement.remove(); await settle();
  const manualReplacement = makeCanvas(); browser.document.body.append(manualReplacement); await settle();
  manualReplacement.focus();
  press('c', 'KeyC', {}, manualReplacement);
  request('UCHI_CAPTURE_DISABLE');
  const manualKeys = messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS' && message.sessionId === 'manual-fallback').flatMap(message => message.keys.map((stroke: any) => stroke.key));
  assert.deepEqual(manualKeys, ['b', 'c'], 'Manual capture must rebind a replacement canvas without losing its key subscription');
});
