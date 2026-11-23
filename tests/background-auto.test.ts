/** Real background handlers + IndexedDB; browser capture is covered separately in CI. */
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearData, getSettings } from '../src/core/db';
import type { CaptureStatus } from '../src/core/types';

const nativeChrome = globalThis.chrome, nativeChannel = globalThis.BroadcastChannel;
(globalThis as any).BroadcastChannel = undefined;
after(() => { (globalThis as any).chrome = nativeChrome; (globalThis as any).BroadcastChannel = nativeChannel; });
beforeEach(async () => { await clearData(); });
let instance = 0;
const token = 'document-token-12345678';
const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), 'The asynchronous capture lifecycle did not settle');
}
async function harness() {
  const id = 'automatic-background', origin = `chrome-extension://${id}/`;
  let handler: (message: any, sender: any, reply: (value: any) => void) => unknown;
  let contexts = false, failContextRead = false, status: CaptureStatus = { state: 'idle', phraseCount: 0 };
  let live: CaptureStatus = { ...status }, closed = 0, mediaRequests = 0;
  let creation: Promise<void> | undefined, frameReply: Promise<any> | undefined;
  const calls: any[] = [], contentMessages: any[] = [];
  const listeners: Record<string, (...args: any[]) => void> = {};
  const listener = (name: string) => ({ addListener(fn: (...args: any[]) => void) { listeners[name] = fn; } });
  const sender = { id, url: 'https://sushida.net/play.html', tab: { id: 9, active: true }, frameId: 0, documentId: 'actual-document' };
  (globalThis as any).chrome = {
    runtime: {
      id, getURL: (path: string) => origin + path, onInstalled: listener('installed'),
      onMessage: { addListener(fn: typeof handler) { handler = fn; } },
      async getContexts() { if (failContextRead) { failContextRead = false; throw new Error('temporary context read failure'); } return contexts ? [{}] : []; },
      async sendMessage(message: any) {
        if (message.target !== 'offscreen') return { ok: true };
        calls.push(message);
        if (message.type === 'UCHI_OFF_START') {
          live = { state: 'recording', source: message.source, tabId: message.tabId, sessionId: message.sessionId, startedAt: message.startedAt, phraseCount: 0 };
          return { ok: true, status: live };
        }
        if (message.type === 'UCHI_OFF_STATUS') return { ok: true, status: live };
        if (message.type === 'UCHI_OFF_STOP') { live = { ...live, state: 'idle' }; return { ok: true, status: live }; }
        if (message.type === 'UCHI_OFF_CANVAS_FRAME' && frameReply) return frameReply;
        return { ok: true };
      },
    },
    storage: { session: {
      async get() { return { captureStatus: structuredClone(status) }; },
      async set(value: any) { if (value.captureStatus) status = structuredClone(value.captureStatus); },
    } },
    action: { onClicked: listener('action'), async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      onRemoved: listener('removed'), onUpdated: listener('updated'),
      async get(tabId: number) { return { id: tabId, active: tabId === 9, url: 'https://sushida.net/play.html' }; },
      async query() { return [{ id: 9, active: true, url: 'https://sushida.net/play.html' }]; },
      async sendMessage(tabId: number, message: any, options: any) { contentMessages.push({ tabId, ...message, options }); return { ok: true }; },
      async create() { return {}; },
    },
    scripting: { async executeScript() { return []; } },
    tabCapture: { onStatusChanged: listener('tabCapture'), async getMediaStreamId() { mediaRequests++; return 'manual-only-stream'; } },
    offscreen: {
      async createDocument() { if (creation) await creation; contexts = true; },
      async closeDocument() { closed++; contexts = false; },
    },
  };
  await import(`../src/capture/background.ts?automatic-test=${++instance}`);
  const send = (message: any, from: any = { id, url: origin + 'sidepanel.html' }) => new Promise<any>((resolve, reject) => {
    try { if (handler(message, from, resolve) !== true) resolve(undefined); } catch (error) { reject(error); }
  });
  return {
    sender, send, calls, contentMessages, listeners,
    ready: (from = sender, documentToken = token) => send({ type: 'UCHI_CANVAS_READY', documentToken }, from),
    content: (message: any, from = sender) => send({ documentToken: token, ...message }, from),
    state: () => status, closed: () => closed, mediaRequests: () => mediaRequests,
    blockCreation: (promise: Promise<void>) => { creation = promise; },
    blockFrames: (promise: Promise<any>) => { frameReply = promise; },
    failNextContextRead: () => { failContextRead = true; },
    notify: (value: CaptureStatus) => send({ type: 'UCHI_OFF_STATE', status: value }, { id, url: origin + 'offscreen.html' }),
  };
}
const frame = (sequence = 1) => ({ width: 900, height: 560, at: Date.now(), sequence, dataUrl: 'data:image/jpeg;base64,AA==' });

test('a visible permitted canvas starts automatically once, without tabCapture or an action click', async () => {
  const app = await harness();
  assert.equal((await getSettings()).autoRecord, true);
  assert.equal(await app.ready({ ...app.sender, url: 'https://example.com/' }), undefined);
  assert.equal((await app.ready({ ...app.sender, tab: { id: 10, active: false } })).busy, true);
  const started = await app.ready();
  assert.ok(started.ok && started.sessionId);
  assert.equal(app.state().source, 'canvas'); assert.equal(app.state().documentToken, token);
  assert.equal((await app.ready()).sessionId, started.sessionId);
  assert.equal(app.calls.filter(c => c.type === 'UCHI_OFF_START').length, 1);
  assert.equal(app.mediaRequests(), 0);
  assert.equal(app.contentMessages.some(m => m.type === 'UCHI_CAPTURE_ENABLE'), false);
  app.failNextContextRead();
  assert.equal((await app.ready()).ok, false);
  assert.equal(app.state().state, 'recording'); assert.equal(app.state().sessionId, started.sessionId);
  assert.equal(app.closed(), 0, 'a failed rediscovery read cannot close the current owner');
  assert.equal((await app.send({ type: 'UCHI_STOP' })).ok, true);
});

test('canvas frames and keys belong to exactly one tab, frame, document, token and capture', async () => {
  const app = await harness(), started = await app.ready();
  const sendFrame = (extra: any = {}, from = app.sender) => app.content({ type: 'UCHI_CANVAS_FRAME', sessionId: started.sessionId, frame: frame(), ...extra }, from);
  assert.equal((await sendFrame()).ok, true);
  const initialFrames = app.calls.filter(c => c.type === 'UCHI_OFF_CANVAS_FRAME').length;
  for (const [extra, sender] of [
    [{ sessionId: 'previous-capture' }, app.sender], [{ documentToken: 'other-document-token' }, app.sender],
    [{}, { ...app.sender, frameId: 2 }], [{}, { ...app.sender, documentId: 'old-document' }],
    [{}, { ...app.sender, tab: { id: 10, active: true } }],
    [{ frame: { ...frame(), width: 2000 } }, app.sender], [{ frame: { ...frame(), at: Date.now() - 60000 } }, app.sender],
  ] as const) assert.equal((await sendFrame(extra, sender as any)).ok, false);
  assert.equal(app.calls.filter(c => c.type === 'UCHI_OFF_CANVAS_FRAME').length, initialFrames);
  const key = { key: 'k', code: 'KeyK', at: Date.now() };
  assert.equal((await app.content({ type: 'UCHI_CAPTURE_KEYS', sessionId: started.sessionId, keys: [key] })).ok, true);
  assert.equal(app.calls.at(-1).type, 'UCHI_OFF_KEYS');
  assert.equal((await app.content({ type: 'UCHI_CAPTURE_KEYS', sessionId: started.sessionId, keys: [key] }, { ...app.sender, documentId: 'stale' })).ok, false);
  assert.equal(app.calls.filter(c => c.type === 'UCHI_OFF_KEYS').length, 1);
  let resolve!: (value: any) => void;
  app.blockFrames(new Promise(done => { resolve = done; }));
  const first = sendFrame({ frame: frame(2) });
  await until(() => app.calls.filter(c => c.type === 'UCHI_OFF_CANVAS_FRAME').length === initialFrames + 1);
  assert.deepEqual(await sendFrame({ frame: frame(3) }), { ok: true, dropped: true });
  resolve({ ok: true }); await first;
  await app.send({ type: 'UCHI_STOP' });
  assert.equal(app.contentMessages.at(-1).options.documentId, 'actual-document');
});

test('hiding auto capture keeps the preference enabled; explicit pause survives rediscovery and reload', async () => {
  const app = await harness(), first = await app.ready();
  assert.equal((await app.content({ type: 'UCHI_CANVAS_END', sessionId: first.sessionId, reason: 'hidden' })).ok, true);
  assert.equal(app.state().state, 'idle'); assert.equal((await getSettings()).autoRecord, true);
  const second = await app.ready(); assert.notEqual(second.sessionId, first.sessionId);
  assert.equal((await app.send({ type: 'UCHI_STOP' })).ok, true);
  assert.equal((await getSettings()).autoRecord, false);
  assert.deepEqual(await app.ready(), { ok: true, paused: true });
  assert.deepEqual(await app.ready({ ...app.sender, documentId: 'new-document' }, 'reloaded-token-1234'), { ok: true, paused: true });
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, true);
  assert.ok(app.contentMessages.some(m => m.type === 'UCHI_CANVAS_PROBE'));
  const third = await app.ready(); assert.ok(third.sessionId && third.sessionId !== second.sessionId);
  const before = app.state();
  assert.equal((await app.notify({ ...before, sessionId: first.sessionId, state: 'idle' })).dropped, true);
  assert.equal(app.state().sessionId, third.sessionId); assert.equal(app.state().state, 'recording');
  assert.equal((await app.content({ type: 'UCHI_CANVAS_END', sessionId: first.sessionId, reason: 'hidden' })).ok, false);
  await app.send({ type: 'UCHI_STOP' });
  assert.equal((await app.notify({ ...before, state: 'recording' })).dropped, true);
  assert.equal(app.state().state, 'idle');
});

test('pausing during automatic startup cancels the pending start and releases media ownership', async () => {
  const app = await harness(); let release!: () => void;
  app.blockCreation(new Promise(done => { release = done; }));
  const opening = app.ready(); await until(() => app.state().state === 'starting');
  const paused = app.send({ type: 'UCHI_STOP' });
  for (let i = 0; i < 100 && (await getSettings()).autoRecord; i++) await delay(5);
  await delay(0); // The committed preference reaches the waiting stop request.
  assert.equal((await getSettings()).autoRecord, false);
  release(); await opening;
  assert.equal((await paused).ok, true); assert.equal(app.state().state, 'idle');
  assert.equal(app.calls.some(c => c.type === 'UCHI_OFF_START'), false);
  assert.equal(app.closed(), 1); assert.deepEqual(await app.ready(), { ok: true, paused: true });
});

test('navigation cancels automatic startup, and tabCapture events do not stop a canvas session', async () => {
  const app = await harness(); let release!: () => void;
  app.blockCreation(new Promise(done => { release = done; }));
  const opening = app.ready(); await until(() => app.state().state === 'starting');
  app.listeners.updated(9, { status: 'loading' }); await delay(5); release(); await opening;
  await until(() => app.state().state === 'idle');
  assert.equal((await getSettings()).autoRecord, true);
  assert.equal(app.calls.some(c => c.type === 'UCHI_OFF_START'), false);
  const resumed = await app.ready();
  app.listeners.tabCapture({ tabId: 9, status: 'stopped' }); await delay(5);
  assert.equal(app.state().state, 'recording'); assert.equal(app.state().sessionId, resumed.sessionId);
  await app.send({ type: 'UCHI_STOP' });
});
