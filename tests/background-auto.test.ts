/** Real background handlers + IndexedDB; browser capture is covered separately in CI. */
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearData, getData, getSettings, importData, updateSettings } from '../src/core/db';
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
async function harness(localStorage: Record<string, unknown> = {}) {
  const id = 'automatic-background', origin = `chrome-extension://${id}/`;
  let handler: (message: any, sender: any, reply: (value: any) => void) => unknown;
  let contexts = false, failContextRead = false, status: CaptureStatus = { state: 'idle', phraseCount: 0 };
  let live: CaptureStatus = { ...status }, closed = 0, mediaRequests = 0;
  let creation: Promise<void> | undefined, frameReply: Promise<any> | undefined, replayReply: Promise<any> | undefined;
  let contextReply: Promise<any[]> | undefined, tabRead: Promise<void> | undefined;
  let localRead: Promise<Record<string, unknown>> | undefined;
  let contextReads = 0, tabReads = 0;
  let localReads = 0;
  let localWriteError = false, localClearError = false;
  let liveDocument = 'actual-document', liveToken = token;
  const calls: any[] = [], contentMessages: any[] = [];
  const listeners: Record<string, (...args: any[]) => void> = {};
  const listener = (name: string) => ({ addListener(fn: (...args: any[]) => void) { listeners[name] = fn; } });
  const sender = { id, url: 'https://sushida.net/play.html', tab: { id: 9, active: true }, frameId: 0, documentId: 'actual-document' };
  (globalThis as any).chrome = {
    runtime: {
      id, getURL: (path: string) => origin + path, onInstalled: listener('installed'),
      onMessage: { addListener(fn: typeof handler) { handler = fn; } },
      async getContexts() {
        contextReads++;
        if (contextReply) { const reply = contextReply; contextReply = undefined; return reply; }
        if (failContextRead) { failContextRead = false; throw new Error('temporary context read failure'); }
        return contexts ? [{}] : [];
      },
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
        if (message.type === 'UCHI_OFF_REPLAY') return replayReply ?? { ok: true, ready: true };
        return { ok: true };
      },
    },
    storage: { local: {
      async get() { localReads++; if (localRead) { const pending = localRead; localRead = undefined; return pending; } return structuredClone(localStorage); },
      async set(value: any) { if (localWriteError || localClearError && value.uchikomiAutomaticPaused === false) throw new Error('Local storage write failed'); Object.assign(localStorage, structuredClone(value)); },
    }, session: {
      async get() { return { captureStatus: structuredClone(status) }; },
      async set(value: any) { if (value.captureStatus) status = structuredClone(value.captureStatus); },
    } },
    action: { onClicked: listener('action'), async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      onRemoved: listener('removed'), onUpdated: listener('updated'),
      async get(tabId: number) {
        tabReads++;
        if (tabRead) { const pending = tabRead; tabRead = undefined; await pending; }
        return { id: tabId, active: tabId === 9, url: 'https://sushida.net/play.html' };
      },
      async query() { return [{ id: 9, active: true, url: 'https://sushida.net/play.html' }]; },
      async sendMessage(tabId: number, message: any, options: any) {
        contentMessages.push({ tabId, ...message, options });
        if (message.type === 'UCHI_CANVAS_CHECK' && (options?.documentId !== liveDocument || message.documentToken !== liveToken)) throw new Error('Receiving end does not exist');
        return { ok: true, documentToken: liveToken };
      },
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
    sender, send, calls, contentMessages, listeners, localStorage,
    ready: (from = sender, documentToken = token) => send({ type: 'UCHI_CANVAS_READY', documentToken }, from),
    content: (message: any, from = sender) => send({ documentToken: token, ...message }, from),
    state: () => status, closed: () => closed, mediaRequests: () => mediaRequests,
    blockCreation: (promise: Promise<void>) => { creation = promise; },
    blockFrames: (promise: Promise<any>) => { frameReply = promise; },
    blockReplay: (promise: Promise<any>) => { replayReply = promise; },
    blockNextContextRead: (promise: Promise<any[]>) => { contextReply = promise; },
    blockNextTabRead: (promise: Promise<void>) => { tabRead = promise; },
    contextReads: () => contextReads, tabReads: () => tabReads,
    setLiveDocument: (id: string, value: string) => { liveDocument = id; liveToken = value; },
    failNextContextRead: () => { failContextRead = true; },
    failLocalWrites: (fail: boolean) => { localWriteError = fail; },
    failLocalClear: (fail: boolean) => { localClearError = fail; },
    blockNextLocalRead: (pending: Promise<Record<string, unknown>>) => { localRead = pending; },
    localReads: () => localReads,
    notify: (value: CaptureStatus) => send({ type: 'UCHI_OFF_STATE', status: value }, { id, url: origin + 'offscreen.html' }),
  };
}
const frame = (sequence = 1) => ({ width: 900, height: 560, at: Date.now(), sequence, dataUrl: 'data:image/jpeg;base64,AA==' });

test('replay requires the selected custom key and the exact current owner, and settings notify that document', async () => {
  const app = await harness(), started = await app.ready();
  assert.equal(started.replayShortcut, 'Escape');
  const replay = (extra: any = {}, from = app.sender) => app.content({ type: 'UCHI_CAPTURE_REPLAY', sessionId: started.sessionId,
    shortcut: 'Shift+Enter', at: Date.now(), ...extra }, from);
  assert.equal((await replay()).ready, false, 'Native Esc does not enable a custom key');
  await updateSettings({ replayShortcut: 'Shift+Enter' });
  assert.equal((await app.send({ type: 'UCHI_REPLAY_SETTINGS_CHANGED' })).ok, true);
  const notice = app.contentMessages.at(-1);
  assert.equal(notice.type, 'UCHI_REPLAY_SETTINGS'); assert.equal(notice.replayShortcut, 'Shift+Enter');
  assert.equal(notice.documentToken, token); assert.equal(notice.options.documentId, 'actual-document');
  for (const [extra, sender] of [
    [{ shortcut: 'Escape' }, app.sender], [{ shortcut: 'F2' }, app.sender], [{ shortcut: 'Enter' }, app.sender],
    [{ sessionId: 'previous-capture' }, app.sender], [{ documentToken: 'old-document-token' }, app.sender],
    [{ at: Date.now() - 3000 }, app.sender], [{}, { ...app.sender, frameId: 2 }],
    [{}, { ...app.sender, documentId: 'stale' }], [{}, { ...app.sender, tab: { id: 10, active: true } }],
  ] as const) assert.equal((await replay(extra, sender as any)).ready, false);
  assert.equal(app.calls.filter(call => call.type === 'UCHI_OFF_REPLAY').length, 0);
  assert.equal(await replay({}, { ...app.sender, url: 'https://example.com/' }), undefined);
  assert.deepEqual(await replay(), { ok: true, ready: true, sessionId: started.sessionId });
  assert.equal(app.calls.filter(call => call.type === 'UCHI_OFF_REPLAY').length, 1);
  await app.send({ type: 'UCHI_STOP' });
});

test('a delayed replay cannot duplicate, survive a settings change or outlive a stopped recording', async () => {
  await updateSettings({ replayShortcut: 'F2' });
  const app = await harness(), started = await app.ready();
  const replay = () => app.content({ type: 'UCHI_CAPTURE_REPLAY', sessionId: started.sessionId, shortcut: 'F2', at: Date.now() });
  let allow!: (value: any) => void;
  app.blockReplay(new Promise(resolve => { allow = resolve; }));
  const first = replay(); await until(() => app.calls.some(call => call.type === 'UCHI_OFF_REPLAY'));
  assert.equal((await replay()).ready, false, 'Only one saving/recognition request may be in flight');
  await updateSettings({ replayShortcut: 'Escape' }); allow({ ok: true, ready: true });
  assert.equal((await first).ready, false);
  await updateSettings({ replayShortcut: 'F2' });
  app.blockReplay(new Promise(resolve => { allow = resolve; }));
  const second = replay(); await until(() => app.calls.filter(call => call.type === 'UCHI_OFF_REPLAY').length === 2);
  await app.send({ type: 'UCHI_STOP' }); allow({ ok: true, ready: true });
  assert.equal((await second).ready, false);
  assert.equal(app.state().state, 'idle');
});

test('manual fallback binds replay to the responding content document token', async () => {
  await updateSettings({ replayShortcut: 'F2' });
  const app = await harness();
  const started = await app.send({ type: 'UCHI_START' });
  assert.equal(started.ok, true); assert.equal(app.state().source, 'tab');
  assert.equal(app.state().documentToken, token);
  const message = { type: 'UCHI_CAPTURE_REPLAY', sessionId: app.state().sessionId, shortcut: 'F2', at: Date.now() };
  assert.equal((await app.content({ ...message, documentToken: 'another-frame-token' })).ready, false);
  assert.equal((await app.content(message)).ready, true);
  await app.send({ type: 'UCHI_STOP' });
});

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
  assert.deepEqual(await app.content({ type: 'UCHI_CANVAS_END', sessionId: first.sessionId, reason: 'hidden' }), { ok: true, ended: true });
  assert.equal(app.state().sessionId, third.sessionId, 'Retrying an old release cannot stop the current owner');
  assert.equal(app.state().state, 'recording');
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

test('an allowed hash update during offscreen creation leaves automatic startup intact', async () => {
  const app = await harness(); let release!: () => void;
  app.blockCreation(new Promise(resolve => { release = resolve; }));
  const opening = app.ready(); await until(() => app.state().state === 'starting');
  const preparingId = app.state().sessionId;
  app.listeners.updated(9, { url: 'https://sushida.net/play.html#result' });
  await delay(); release();
  const started = await opening;
  assert.equal(started.sessionId, preparingId, 'A same-document URL update must not cancel the pending owner');
  assert.equal(app.state().state, 'recording');
  assert.equal(app.calls.filter(call => call.type === 'UCHI_OFF_START').length, 1);
  assert.equal(app.calls.some(call => call.type === 'UCHI_OFF_STOP'), false);
  assert.equal((await app.ready()).sessionId, started.sessionId);
  assert.equal((await app.content({ type: 'UCHI_CANVAS_FRAME', sessionId: started.sessionId, frame: frame() })).ok, true);
  assert.ok(app.calls.some(call => call.type === 'UCHI_OFF_CANVAS_FRAME'));
  await app.send({ type: 'UCHI_STOP' });
});

test('a delayed absent-offscreen status response cannot erase a newer capture owner', async () => {
  const app = await harness(), first = await app.ready();
  let resolveAbsent!: (value: any[]) => void;
  const reads = app.contextReads();
  app.blockNextContextRead(new Promise(resolve => { resolveAbsent = resolve; }));
  const oldStatus = app.send({ type: 'UCHI_STATUS' });
  await until(() => app.contextReads() > reads);
  await app.content({ type: 'UCHI_CANVAS_END', sessionId: first.sessionId, reason: 'hidden' });
  const second = await app.ready();
  assert.notEqual(second.sessionId, first.sessionId);
  resolveAbsent([]);
  const reply = await oldStatus;
  assert.equal(reply.status.state, 'recording'); assert.equal(reply.status.sessionId, second.sessionId);
  assert.equal(app.state().state, 'recording'); assert.equal(app.state().sessionId, second.sessionId);
  await app.send({ type: 'UCHI_STOP' });
});

test('navigation before startup publishes an owner cancels the old document and admits the new one', async () => {
  const app = await harness(); let release!: () => void;
  app.blockNextTabRead(new Promise(resolve => { release = resolve; }));
  const opening = app.ready(); await until(() => app.tabReads() === 1);
  assert.equal(app.state().state, 'idle', 'Navigation happens before the old owner is published');
  app.listeners.updated(9, { status: 'loading' });
  app.setLiveDocument('new-document', 'reloaded-token-1234');
  await delay(); release();
  assert.equal((await opening).busy, true);
  assert.equal(app.calls.some(call => call.type === 'UCHI_OFF_START'), false);
  const next = await app.ready({ ...app.sender, documentId: 'new-document' }, 'reloaded-token-1234');
  assert.ok(next.sessionId); assert.equal(app.state().documentId, 'new-document');
  await app.send({ type: 'UCHI_STOP' });
});

test('a READY from an iframe document that no longer exists cannot claim startup', async () => {
  const app = await harness();
  app.setLiveDocument('replacement-document', 'replacement-token-1234');
  assert.equal((await app.ready()).busy, true);
  assert.equal(app.calls.some(call => call.type === 'UCHI_OFF_START'), false);
  const check = app.contentMessages.find(message => message.type === 'UCHI_CANVAS_CHECK');
  assert.equal(check.options.documentId, app.sender.documentId);
  const next = await app.ready({ ...app.sender, documentId: 'replacement-document' }, 'replacement-token-1234');
  assert.ok(next.sessionId); assert.equal(app.state().documentToken, 'replacement-token-1234');
  await app.send({ type: 'UCHI_STOP' });
});

test('pause releases capture and suppresses automatic restart even when the settings write fails', async t => {
  const app = await harness(), first = await app.ready();
  const original = IDBObjectStore.prototype.put;
  const fail = t.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'settings') throw new DOMException('Storage is full', 'QuotaExceededError');
    return original.apply(this, args);
  });
  const stopped = await app.send({ type: 'UCHI_STOP' });
  assert.equal(stopped.ok, false); assert.match(stopped.error, /設定を保存できません/);
  assert.equal(app.state().state, 'idle'); assert.equal(app.closed(), 1);
  assert.ok(app.contentMessages.some(message => message.type === 'UCHI_CAPTURE_DISABLE'));
  assert.ok(app.calls.some(call => call.type === 'UCHI_OFF_STOP'));
  assert.equal((await getSettings()).autoRecord, true, 'The failure leaves the persisted preference unchanged');
  assert.deepEqual(await app.ready(), { ok: true, paused: true });
  fail.mock.restore();
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, true);
  const next = await app.ready(); assert.ok(next.sessionId && next.sessionId !== first.sessionId);
  await app.send({ type: 'UCHI_STOP' });
});

test('a shortcut saved during startup is reflected in the READY response', async () => {
  const app = await harness(); let release!: () => void;
  app.blockCreation(new Promise(resolve => { release = resolve; }));
  const opening = app.ready(); await until(() => app.state().state === 'starting');
  await updateSettings({ replayShortcut: 'F2' });
  await app.send({ type: 'UCHI_REPLAY_SETTINGS_CHANGED' });
  const notice = app.contentMessages.find(message => message.type === 'UCHI_REPLAY_SETTINGS');
  assert.equal(notice.replayShortcut, 'F2');
  release();
  const started = await opening;
  assert.equal(started.replayShortcut, 'F2'); assert.equal(started.sessionId, notice.sessionId);
  await app.send({ type: 'UCHI_STOP' });
});

test('a pause survives worker restart after a failed DB write and clears only after a successful explicit resume', async t => {
  let app = await harness(); await app.ready();
  const original = IDBObjectStore.prototype.put;
  const fail = t.mock.method(IDBObjectStore.prototype, 'put', function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'settings') throw new DOMException('Storage is full', 'QuotaExceededError');
    return original.apply(this, args);
  });
  assert.equal((await app.send({ type: 'UCHI_STOP' })).ok, false);
  assert.equal(app.state().autoRecordPaused, true);
  assert.equal((await getSettings()).autoRecord, true);
  app = await harness(app.localStorage); // New module state, same durable extension storage.
  assert.equal((await app.send({ type: 'UCHI_STATUS' })).status.autoRecordPaused, true, 'A status-only read after worker restart exposes the durable pause');
  assert.deepEqual(await app.ready(), { ok: true, paused: true });
  assert.equal((await app.send({ type: 'UCHI_REPLAY_SETTINGS_CHANGED' })).ok, true);
  assert.deepEqual(await app.ready(), { ok: true, paused: true }, 'Ordinary shortcut saves cannot release a pause');
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, false, 'A failed settings write cannot release the latch');
  fail.mock.restore();
  app.failLocalWrites(true);
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, false, 'A failed durable guard update cannot release the pause');
  app.failLocalWrites(false); app.failLocalClear(true);
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, false, 'A failed latch clear after the DB write also leaves the pause intact');
  assert.equal((await getSettings()).autoRecord, true);
  app = await harness(app.localStorage);
  assert.deepEqual(await app.ready(), { ok: true, paused: true });
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, true);
  assert.equal(app.state().autoRecordPaused, false, 'A successful resume also broadcasts the unpaused state');
  const started = await app.ready(); assert.ok(started.sessionId);
  await app.send({ type: 'UCHI_STOP' });
});

test('explicit restored settings enable auto recording after a pause and synchronize the restored shortcut', async () => {
  const app = await harness(); await app.ready(); await app.send({ type: 'UCHI_STOP' });
  const backup = await getData();
  await importData({ ...backup, version: 1, settings: { ...backup.settings, autoRecord: true, replayShortcut: 'F2' } });
  await app.send({ type: 'UCHI_REPLAY_SETTINGS_CHANGED' });
  assert.deepEqual(await app.ready(), { ok: true, paused: true });
  assert.equal(await app.content({ type: 'UCHI_SETTINGS_RESTORED' }), undefined, 'Only trusted extension UI may apply a restored pause preference');
  app.failLocalWrites(true);
  assert.equal((await app.send({ type: 'UCHI_SETTINGS_RESTORED' })).ok, false);
  assert.deepEqual(await app.ready(), { ok: true, paused: true }, 'A failed restore notification must leave the pause in place');
  app.failLocalWrites(false);
  assert.equal((await app.send({ type: 'UCHI_SETTINGS_RESTORED' })).ok, true);
  assert.equal(app.state().autoRecordPaused, false);
  assert.ok(app.contentMessages.some(message => message.type === 'UCHI_CANVAS_PROBE'));
  const started = await app.ready(); assert.ok(started.sessionId); assert.equal(started.replayShortcut, 'F2');
  await app.send({ type: 'UCHI_STOP' });
});

test('restoring autoRecord false stops automatic capture but preserves a manual tab capture', async () => {
  const app = await harness(); await app.ready();
  const backup = await getData();
  await importData({ ...backup, version: 1, settings: { ...backup.settings, autoRecord: false } });
  app.failLocalWrites(true); // The successfully imported false preference still provides durable pause.
  assert.equal((await app.send({ type: 'UCHI_SETTINGS_RESTORED' })).ok, true);
  assert.equal(app.state().state, 'idle'); assert.equal(app.closed(), 1);
  assert.deepEqual(await app.ready(), { ok: true, paused: true });
  assert.equal((await app.send({ type: 'UCHI_START' })).ok, true);
  const manualId = app.state().sessionId, stops = app.calls.filter(call => call.type === 'UCHI_OFF_STOP').length;
  await importData({ ...backup, version: 1, settings: { ...backup.settings, autoRecord: false, replayShortcut: 'F2' } });
  assert.equal((await app.send({ type: 'UCHI_SETTINGS_RESTORED' })).ok, true);
  assert.equal(app.state().source, 'tab'); assert.equal(app.state().state, 'recording'); assert.equal(app.state().sessionId, manualId);
  assert.equal(app.state().autoRecordPaused, true);
  const { autoRecordPaused: _paused, ...offscreenStatus } = app.state();
  await app.notify(offscreenStatus);
  assert.equal(app.state().autoRecordPaused, true, 'An offscreen status lacking the UI flag cannot erase the effective pause');
  assert.equal(app.calls.filter(call => call.type === 'UCHI_OFF_STOP').length, stops, 'A restored automatic preference does not stop manual media access');
  const notice = app.contentMessages.findLast(message => message.type === 'UCHI_REPLAY_SETTINGS');
  assert.equal(notice.sessionId, manualId); assert.equal(notice.replayShortcut, 'F2');
  await app.send({ type: 'UCHI_STOP' });
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, false);
  assert.equal((await getSettings()).autoRecord, false, 'A failed local guard must not re-enable a durable DB-only pause');
});

test('restoring autoRecord false also cancels automatic startup before offscreen is ready', async () => {
  const app = await harness(); let release!: () => void;
  app.blockCreation(new Promise(resolve => { release = resolve; }));
  const opening = app.ready(); await until(() => app.state().state === 'starting');
  const backup = await getData();
  await importData({ ...backup, version: 1, settings: { ...backup.settings, autoRecord: false } });
  const restored = app.send({ type: 'UCHI_SETTINGS_RESTORED' });
  await delay(5); release(); await opening;
  assert.equal((await restored).ok, true); assert.equal(app.state().state, 'idle');
  assert.equal(app.calls.some(call => call.type === 'UCHI_OFF_START'), false);
  assert.deepEqual(await app.ready(), { ok: true, paused: true });
});

test('a slow durable pause read cannot replace the state of a newer explicit resume', async () => {
  let app = await harness(); await app.ready(); await app.send({ type: 'UCHI_STOP' });
  app = await harness(app.localStorage);
  const pausedSnapshot = structuredClone(app.localStorage), reads = app.localReads();
  let release!: (value: Record<string, unknown>) => void;
  app.blockNextLocalRead(new Promise(resolve => { release = resolve; }));
  const oldStatus = app.send({ type: 'UCHI_STATUS' });
  await until(() => app.localReads() > reads);
  assert.equal((await app.send({ type: 'UCHI_RESUME' })).ok, true);
  assert.equal(app.state().autoRecordPaused, false);
  release(pausedSnapshot);
  assert.equal((await oldStatus).status.autoRecordPaused, false);
  assert.equal((await app.send({ type: 'UCHI_STATUS' })).status.autoRecordPaused, false);
  await app.send({ type: 'UCHI_STOP' });
});
