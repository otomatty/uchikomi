/** Real Practice + IndexedDB integration with a controllable wall clock and checkpoint timer. */
import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import type { Phrase, Session } from '../src/core/types';

const browser = new Window({ url: 'https://uchikomi.test/index.html' });
const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'KeyboardEvent', 'Event']) {
  define(name, name === 'window' ? browser : (browser as any)[name]);
}
define('requestAnimationFrame', browser.requestAnimationFrame.bind(browser));
define('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
define('indexedDB', new IDBFactory()); define('IDBKeyRange', IDBKeyRange);
define('BroadcastChannel', undefined); define('IS_REACT_ACT_ENVIRONMENT', true);
Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

let now = Date.parse('2026-12-24T14:59:50.000Z');
const nativeNow = Date.now, nativeInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
Date.now = () => now;
const intervals = new Map<object, { callback: () => void; delay: number }>();
define('setInterval', (callback: () => void, delay: number) => { const id = {}; intervals.set(id, { callback, delay }); return id; });
define('clearInterval', (id: object) => { if (!intervals.delete(id)) nativeClearInterval(id as any); });
const nativePut = IDBObjectStore.prototype.put;
let sessionWrites: Session[] = [], rejectActivityWrites = false;
IDBObjectStore.prototype.put = function (value: unknown, ...args: any[]) {
  if (this.name === 'sessions') {
    const session = value as Session;
    if (rejectActivityWrites && session.activity?.some(row => row.keys)) throw new DOMException('test quota', 'QuotaExceededError');
    sessionWrites.push(structuredClone(session));
  }
  return nativePut.call(this, value, ...args);
};

const React = await import('react'), { act } = React;
const { createRoot } = await import('react-dom/client');
const { AppProvider } = await import('../src/app/shared');
const { default: Practice } = await import('../src/app/Practice');
const db = await import('../src/core/db');
let container: HTMLElement, root: ReturnType<typeof createRoot>, exited = 0, unsaved = false;
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const phrase = (): Phrase => ({ id: 'activity-word', text: '途中の練習', reading: '', roman: 'abcdefghij', source: 'manual', confidence: 100, verified: true, capturedAt: now, lastSeenAt: now, seenCount: 1 });
function element<T extends Element = HTMLElement>(selector: string): T { const found = document.querySelector<T>(selector); assert.ok(found, selector); return found; }
function button(text: string): HTMLButtonElement { const found = [...document.querySelectorAll('button')].find(value => value.textContent?.trim() === text); assert.ok(found, text); return found; }
function dispatch(key: string, code = key === ' ' ? 'Space' : `Key${key.toUpperCase()}`) {
  element('[data-testid="practice-input"]').dispatchEvent(new browser.KeyboardEvent('keydown', { key, code, bubbles: true }));
}
async function press(key: string, advance = 0) { now += advance; await act(async () => { dispatch(key, key === 'Escape' ? 'Escape' : undefined); await delay(); }); }
async function settle(predicate: () => boolean) { for (let i = 0; i < 600 && !predicate(); i++) await act(async () => { await delay(); }); assert.ok(predicate(), document.body.textContent ?? 'did not settle'); }
async function checkpoint() { await act(async () => { for (const timer of intervals.values()) if (timer.delay === 5000) timer.callback(); await delay(); await delay(); }); }
async function savedSession() { let values: Session[] = []; await act(async () => { await delay(); values = (await db.getData()).sessions; }); assert.equal(values.length, 1); return values[0]; }

beforeEach(async () => {
  now = Date.parse('2026-12-24T14:59:50.000Z'); rejectActivityWrites = false; exited = 0; unsaved = false;
  await db.clearData(); const word = phrase(); await db.savePhrase(word); sessionWrites = [];
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(React.createElement(AppProvider, null, React.createElement(Practice, { queue: [word], onExit: () => { exited++; }, onAgain() {}, onUnsavedChange: value => { unsaved = value; } }))); await delay(); });
  element<HTMLElement>('[data-testid="practice-input"]').focus();
});
afterEach(async () => { rejectActivityWrites = false; await act(async () => { root.unmount(); await delay(); }); container.remove(); await browser.happyDOM.cancelAsync(); });
after(async () => {
  Date.now = nativeNow; define('setInterval', nativeInterval); define('clearInterval', nativeClearInterval); IDBObjectStore.prototype.put = nativePut;
  await browser.happyDOM.close();
});

test('an open practice and its start Space add no volume, while a partial phrase keeps real-day keys and pauses', async () => {
  now += 1000; await checkpoint(); assert.equal((await db.getData()).sessions.length, 0);
  await press(' '); await settle(() => !!document.querySelector('.roman-line .cursor'));
  assert.deepEqual((await savedSession()).activity, []);
  now = Date.parse('2026-12-24T14:59:59.900Z'); await press('a');
  await press(' ', 50); // A real mistyped Space during the prompt is physical input.
  await press('b', 150); // JST midnight; analysis' pause-adjusted clock is not used here.
  await press('Escape', 100); await settle(() => !!document.querySelector('.pause-overlay'));
  assert.deepEqual((await savedSession()).activity, [
    { date: '2026-12-24', activeMs: 100, keys: 2, phrases: 1 },
    { date: '2026-12-25', activeMs: 100, keys: 1, phrases: 0 },
  ]);
  await press(' ', 2000); // Resume is not an input event; a short pause still breaks time.
  await press('c', 200); await press('q', 100);
  await act(async () => { button('練習を終了').click(); await delay(); });
  await settle(() => exited === 1);
  const saved = await savedSession();
  assert.ok(saved.endedAt); assert.equal(saved.phraseCount, 0);
  assert.deepEqual(saved.activity, [
    { date: '2026-12-24', activeMs: 100, keys: 2, phrases: 1 },
    { date: '2026-12-25', activeMs: 200, keys: 3, phrases: 0 },
  ]);
  assert.equal((await db.getData()).attempts.length, 0, 'incomplete speed results stay separate from physical practice volume');
});

test('five-second checkpoints persist partial input and cannot overwrite newer leave snapshots', async () => {
  await press(' '); await settle(() => !!document.querySelector('.roman-line .cursor'));
  await press('a', 100); await press('b', 100);
  assert.equal(sessionWrites.length, 1, 'individual keys do not write a session');
  now += 5000; await checkpoint();
  assert.deepEqual((await savedSession()).activity, [{ date: '2026-12-24', activeMs: 100, keys: 2, phrases: 1 }]);
  now += 100;
  await act(async () => {
    for (const timer of intervals.values()) if (timer.delay === 5000) timer.callback();
    dispatch('c');
    for (const timer of intervals.values()) if (timer.delay === 5000) timer.callback();
    dispatch('d');
    button('練習を終了').click();
    await delay();
  });
  await settle(() => exited === 1);
  assert.deepEqual((await savedSession()).activity, [{ date: '2026-12-24', activeMs: 100, keys: 4, phrases: 1 }]);
  const backup = await db.exportData();
  await act(async () => { await db.clearData(); await db.importData(backup); await delay(); });
  assert.deepEqual((await db.getData()).sessions[0].activity, backup.sessions[0].activity);
});

test('a failed partial-input checkpoint retains retry controls and the unsaved-data guard', async () => {
  await press(' '); await settle(() => !!document.querySelector('.roman-line .cursor'));
  await press('a', 100); await press('b', 100);
  rejectActivityWrites = true; await checkpoint();
  await settle(() => unsaved);
  await act(async () => { button('練習を終了').click(); await delay(); });
  await settle(() => !!document.querySelector('[data-testid="practice-complete"]'));
  assert.equal(exited, 0); assert.equal(unsaved, true);
  assert.equal(button('もう1セット').disabled, true);
  rejectActivityWrites = false;
  await act(async () => { button('保存を再試行').click(); await delay(); });
  await settle(() => !unsaved);
  assert.deepEqual((await savedSession()).activity, [{ date: '2026-12-24', activeMs: 100, keys: 2, phrases: 1 }]);
});

test('repeating the same keyword counts each typed occurrence, including the unfinished next word', async () => {
  const word = phrase();
  await act(async () => {
    root.render(React.createElement(AppProvider, null, React.createElement(Practice, { queue: [word, word], onExit: () => { exited++; }, onAgain() {} })));
    await delay();
  });
  await press(' '); await settle(() => !!document.querySelector('.roman-line .cursor'));
  for (const key of word.roman) await press(key, 100);
  await settle(() => document.querySelector('.practice-count > span')?.textContent === '02' && !!document.querySelector('.roman-line .cursor'));
  await press('q', 100); // A mistake still makes the second occurrence a practiced word.
  await act(async () => { button('練習を終了').click(); await delay(); });
  await settle(() => exited === 1);
  const saved = await savedSession();
  assert.equal(saved.phraseCount, 1);
  assert.deepEqual(saved.activity, [{ date: '2026-12-24', activeMs: 900, keys: 11, phrases: 2 }]);
  assert.equal((await db.getData()).attempts.length, 1);
});
