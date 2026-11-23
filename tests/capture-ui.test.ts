/** First-run capture UX with a Chrome message stub; this is not a live tabCapture test. */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { CaptureStatus } from '../src/core/types';

const browser = new Window({ url: 'https://uchikomi.test/sidepanel.html', width: 380, height: 900 });
const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
for (const name of ['window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'Element', 'HTMLInputElement', 'Event', 'MouseEvent']) {
  define(name, name === 'window' ? browser : (browser as any)[name]);
}
define('requestAnimationFrame', browser.requestAnimationFrame.bind(browser));
define('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
define('indexedDB', new IDBFactory());
define('IDBKeyRange', IDBKeyRange);
define('BroadcastChannel', class { postMessage() {} close() {} });
define('IS_REACT_ACT_ENVIRONMENT', true);

const messages: string[] = [];
const listeners = new Set<(message: unknown) => void>();
let status: CaptureStatus = { state: 'idle', phraseCount: 0 };
const publish = (patch: Partial<CaptureStatus>) => {
  status = { ...status, ...patch };
  for (const listener of listeners) listener({ type: 'UCHI_STATE', status });
};
define('chrome', {
  runtime: {
    id: 'uchikomi-test',
    getURL: (path: string) => `chrome-extension://uchikomi-test/${path}`,
    onMessage: { addListener: (fn: (m: unknown) => void) => listeners.add(fn), removeListener: (fn: (m: unknown) => void) => listeners.delete(fn) },
    async sendMessage(message: { type: string }) {
      messages.push(message.type);
      if (message.type === 'UCHI_RESUME') { await db.updateSettings({ autoRecord: true }); publish({ state: 'idle' }); }
      if (message.type === 'UCHI_AUTO_REGION') publish({ regionState: 'searching', region: undefined, regionConfidence: undefined });
      if (message.type === 'UCHI_STOP') { await db.updateSettings({ autoRecord: false }); publish({ state: 'idle' }); }
      return { ok: true, status, sessionId: status.activeSessionId||status.sessionId };
    },
  },
  tabs: { create: async () => ({}) },
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../src/app/App');
const { AppProvider } = await import('../src/app/shared');
const db = await import('../src/core/db');
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await act(async () => { await delay(10); });
  assert.ok(predicate(), document.body.textContent ?? 'UI did not settle');
}

before(async () => {
  await db.clearData();
  assert.equal((await db.getData()).settings.calibration, undefined);
  await act(async () => { root.render(createElement(AppProvider, null, createElement(App))); });
  await settle(() => Boolean(document.querySelector('[data-testid="capture-card"]')));
});

after(async () => {
  await act(async () => { root.unmount(); await delay(0); });
  await browser.happyDOM.close();
});

test('automatic capture shows its status without a start button or range-selection dialog', async () => {
  assert.equal((await db.getData()).settings.autoRecord, true);
  assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some(b => b.textContent?.includes('記録をはじめる')), false);
  assert.match(document.querySelector('[data-testid="capture-card"]')?.textContent ?? '', /開くだけで、記録/);
  await act(async () => { publish({ state: 'recording', source: 'canvas', ocrReady: true, regionState: 'searching', startedAt: Date.now(), sessionId: 'first-session' }); await delay(0); });
  await settle(() => document.querySelector('[data-testid="capture-region"]')?.textContent?.includes('お題を探しています') === true);
  assert.equal(messages.includes('UCHI_START'), false);
  assert.equal(document.querySelector('.wave-bars'), null);
  assert.equal(document.querySelector('.capture-heading .spin'), null);
  assert.equal(messages.includes('UCHI_FRAME'), false);
  assert.equal(messages.includes('UCHI_CALIBRATE'), false);
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('automatic lock is visible and retry returns to searching without losing captured count', async () => {
  await act(async () => { publish({ regionState: 'locked', regionConfidence: .96, phraseCount: 3, latestPhrase: '引っ越しの準備' }); await delay(0); });
  assert.match(document.querySelector('[data-testid="capture-region"]')?.textContent ?? '', /お題欄を自動検出/);
  const retry = document.querySelector<HTMLButtonElement>('button[aria-label="お題欄を再検出"]');
  assert.ok(retry);
  await act(async () => { retry.click(); await delay(0); });
  assert.ok(messages.includes('UCHI_AUTO_REGION'));
  assert.match(document.querySelector('[data-testid="capture-region"]')?.textContent ?? '', /お題を探しています/);
  assert.equal(document.querySelector('.captured-count strong')?.textContent, '3');
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test('an automatically recorded score is visible and stopping does not force manual score entry', async () => {
  const now=Date.now();
  await act(async()=>{
    await db.saveSession({id:'first-session',source:'capture',startedAt:now-120000,endedAt:now,score:29740,scoreType:'total',scoreSource:'ocr',scoreConfidence:96,scoreObservedAt:now,scoreTotal:29740,course:10000,mode:'accuracy',phraseCount:3,correctKeys:30,mistakes:1,durationMs:120000});
    publish({state:'recording',activeSessionId:'first-session',scoreState:'saved',latestScore:{sessionId:'first-session',score:29740,scoreType:'total',confidence:96}});
    await delay(20);
  });
  await settle(()=>Boolean(document.querySelector('[data-testid="auto-score"]')));
  assert.match(document.querySelector('[data-testid="auto-score"]')?.textContent??'',/29,740/);
  assert.match(document.querySelector('[data-testid="auto-score"]')?.textContent??'',/合計/);
  assert.match(document.querySelector('.panel-goal')?.textContent??'',/29,740/);
  assert.doesNotMatch(document.body.textContent??'',/お得|利益|profit/i);
  const stop=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.includes('記録を一時停止'));
  assert.ok(stop);await act(async()=>{stop.click();await delay(30);});
  await settle(()=>messages.includes('UCHI_STOP'));
  assert.equal(document.querySelector('[role="dialog"]'),null);
  assert.equal((await db.getData()).sessions[0].score,29740);assert.equal((await db.getData()).sessions[0].scoreType,'total');
});

test('pause exposes a resume control and resuming preserves all saved records', async () => {
  await settle(() => document.querySelector('[data-testid="capture-card"]')?.textContent?.includes('自動記録を一時停止中') === true);
  assert.equal((await db.getData()).settings.autoRecord, false);
  const saved = (await db.getData()).sessions;
  const resume = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('自動記録を再開'));
  assert.ok(resume);
  await act(async () => { resume.click(); await delay(30); });
  await settle(() => document.querySelector('[data-testid="capture-card"]')?.textContent?.includes('自動記録を待機') === true);
  assert.equal((await db.getData()).settings.autoRecord, true);
  assert.deepEqual((await db.getData()).sessions, saved);
  assert.ok(messages.includes('UCHI_RESUME'));
  assert.equal(messages.includes('UCHI_START'), false);
});
