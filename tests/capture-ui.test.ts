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
const replayUpdates: string[] = [];
let failStop = false, failRestore = false;
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
      if (message.type === 'UCHI_STOP' && failStop) return { ok: false, error: '停止通知を送れませんでした' };
      if (message.type === 'UCHI_SETTINGS_RESTORED' && failRestore) return { ok: false, error: '設定通知を送れませんでした' };
      if (message.type === 'UCHI_RESUME') { await db.updateSettings({ autoRecord: true }); publish({ state: 'idle', autoRecordPaused: false }); }
      if (message.type === 'UCHI_AUTO_REGION') publish({ regionState: 'searching', region: undefined, regionConfidence: undefined });
      if (message.type === 'UCHI_STOP') { await db.updateSettings({ autoRecord: false }); publish({ state: 'idle', autoRecordPaused: true }); }
      if (message.type === 'UCHI_SETTINGS_RESTORED') publish({ autoRecordPaused: !(await db.getSettings()).autoRecord });
      if (message.type === 'UCHI_REPLAY_SETTINGS_CHANGED' || message.type === 'UCHI_SETTINGS_RESTORED') replayUpdates.push((await db.getSettings()).replayShortcut);
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

test('settings saves the selected replay key before notifying live capture and keeps the choice when reopened', async () => {
  const sessions = (await db.getData()).sessions;
  const openSettings = async () => {
    const open = document.querySelector<HTMLButtonElement>('[data-testid="nav-settings"]'); assert.ok(open);
    await act(async () => { open.click(); await delay(0); });
    await settle(() => Boolean(document.querySelector('[role="dialog"]')));
    const select = document.querySelector<HTMLSelectElement>('[data-testid="replay-shortcut"]'); assert.ok(select);
    return select;
  };
  const saveSettings = async () => {
    const save = document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]'); assert.ok(save);
    await act(async () => { save.click(); await delay(0); });
    await settle(() => !document.querySelector('[role="dialog"]'));
  };
  let select = await openSettings();
  assert.equal(select.value, 'Escape');
  assert.equal(select.getAttribute('aria-label'), '再プレイのキー');
  assert.deepEqual([...select.options].map(option => [option.value, option.textContent]), [['Escape', 'Esc（標準）'], ['Shift+Enter', 'Shift + Enter'], ['F2', 'F2']]);
  assert.match(document.querySelector('#replay-shortcut-hint')?.textContent ?? '', /寿司打の結果画面で使えます。Escはいつでも使えます。/);
  for (const replayShortcut of ['Shift+Enter', 'F2']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLSelectElement.prototype, 'value')!.set!.call(select, replayShortcut);
      select.dispatchEvent(new browser.Event('change', { bubbles: true })); await delay(0);
    });
    await saveSettings();
    assert.equal((await db.getSettings()).replayShortcut, replayShortcut);
    assert.equal(replayUpdates.at(-1), replayShortcut, 'the background notification observes the committed setting');
    select = await openSettings(); assert.equal(select.value, replayShortcut);
  }
  const updates = replayUpdates.length;
  await saveSettings();
  assert.equal(replayUpdates.length, updates, 'an unchanged save does not notify again');
  assert.deepEqual((await db.getData()).sessions, sessions);
});

test('restoring an older backup through settings informs live capture that native Escape is selected again', async () => {
  assert.equal((await db.getSettings()).replayShortcut, 'F2');
  const backup = await db.exportData(), { replayShortcut: _, ...settings } = backup.settings;
  const file = new browser.File([JSON.stringify({ ...backup, settings })], 'legacy-shortcuts.json', { type: 'application/json' });
  const transfer = new browser.DataTransfer(); transfer.items.add(file);
  const open = document.querySelector<HTMLButtonElement>('[data-testid="nav-settings"]'); assert.ok(open);
  await act(async () => { open.click(); await delay(0); });
  const upload = document.querySelector<HTMLInputElement>('[data-testid="import-file"]'); assert.ok(upload);
  const updates = replayUpdates.length;
  await act(async () => { upload.files = transfer.files as unknown as FileList; upload.dispatchEvent(new browser.Event('change', { bubbles: true })); await delay(0); });
  await settle(() => !document.querySelector('[role="dialog"]'));
  assert.equal((await db.getSettings()).replayShortcut, 'Escape');
  assert.equal(replayUpdates.length, updates + 1);
  assert.equal(replayUpdates.at(-1), 'Escape');
  assert.deepEqual((await db.getData()).sessions, backup.sessions);
});

test('saving an unrelated setting preserves a pause made after opening the form', async () => {
  await act(async () => { await db.updateSettings({ autoRecord: true }); publish({ state: 'idle' }); await delay(20); });
  const open = document.querySelector<HTMLButtonElement>('[data-testid="nav-settings"]'); assert.ok(open);
  await act(async () => { open.click(); await delay(0); });
  const toggle = document.querySelector<HTMLInputElement>('[role="switch"]'); assert.ok(toggle); assert.equal(toggle.checked, true);
  await act(async () => { await db.updateSettings({ autoRecord: false, replayShortcut: 'F2' }); await delay(20); });
  const resumeCount = messages.filter(type => type === 'UCHI_RESUME').length;
  const target = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="number"]'); assert.ok(target);
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(target, '32000');
    target.dispatchEvent(new browser.Event('input', { bubbles: true })); await delay(0);
  });
  const save = document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]'); assert.ok(save);
  await act(async () => { save.click(); await delay(0); });
  await settle(() => !document.querySelector('[role="dialog"]'));
  const settings = await db.getSettings();
  assert.equal(settings.autoRecord, false); assert.equal(settings.replayShortcut, 'F2'); assert.equal(settings.targetScore, 32000);
  assert.equal(messages.filter(type => type === 'UCHI_RESUME').length, resumeCount);
  // An explicit switch edit still resumes capture even after another window paused it.
  await act(async () => { open.click(); await delay(0); });
  const resume = document.querySelector<HTMLInputElement>('[role="switch"]'); assert.ok(resume);
  await act(async () => { resume.click(); await delay(0); });
  const confirm = document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]'); assert.ok(confirm);
  await act(async () => { confirm.click(); await delay(0); });
  await settle(() => !document.querySelector('[role="dialog"]'));
  assert.equal((await db.getSettings()).autoRecord, true);
  assert.equal(messages.filter(type => type === 'UCHI_RESUME').length, resumeCount + 1);
});

test('saving an unrelated target while auto-record is disabled keeps an active manual capture', async () => {
  await act(async () => { await db.updateSettings({ autoRecord: false }); publish({ state: 'recording', source: 'tab' }); await delay(20); });
  const before = messages.filter(type => type === 'UCHI_STOP').length;
  const open = document.querySelector<HTMLButtonElement>('[data-testid="nav-settings"]'); assert.ok(open);
  await act(async () => { open.click(); await delay(0); });
  const toggle = document.querySelector<HTMLInputElement>('[role="switch"]'); assert.ok(toggle); assert.equal(toggle.checked, false);
  const target = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="number"]'); assert.ok(target);
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(target, '33000');
    target.dispatchEvent(new browser.Event('input', { bubbles: true })); await delay(0);
  });
  const save = document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]'); assert.ok(save);
  await act(async () => { save.click(); await delay(0); });
  await settle(() => !document.querySelector('[role="dialog"]'));
  assert.equal(messages.filter(type => type === 'UCHI_STOP').length, before);
  assert.equal(status.state, 'recording'); assert.equal(status.source, 'tab');
  assert.equal((await db.getSettings()).autoRecord, false); assert.equal((await db.getSettings()).targetScore, 33000);
});

test('an explicit auto-record disable retries its failed stop notification without another switch change', async t => {
  t.after(() => { failStop = false; });
  await act(async () => { await db.updateSettings({ autoRecord: true }); publish({ state: 'recording', source: 'tab' }); await delay(20); });
  const before = messages.filter(type => type === 'UCHI_STOP').length;
  const open = document.querySelector<HTMLButtonElement>('[data-testid="nav-settings"]'); assert.ok(open);
  await act(async () => { open.click(); await delay(0); });
  const toggle = document.querySelector<HTMLInputElement>('[role="switch"]'); assert.ok(toggle); assert.equal(toggle.checked, true);
  await act(async () => { toggle.click(); await delay(0); });
  failStop = true;
  const save = document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]'); assert.ok(save);
  await act(async () => { save.click(); await delay(20); });
  await settle(() => Boolean(document.querySelector('[role="dialog"] [role="alert"]')));
  assert.equal((await db.getSettings()).autoRecord, false); assert.equal(status.state, 'recording');
  assert.equal(messages.filter(type => type === 'UCHI_STOP').length, before + 1);
  failStop = false;
  await act(async () => { save.click(); await delay(20); });
  await settle(() => !document.querySelector('[role="dialog"]'));
  assert.equal(status.state, 'idle'); assert.equal((await db.getSettings()).autoRecord, false);
  assert.equal(messages.filter(type => type === 'UCHI_STOP').length, before + 2);
});

test('a committed backup remains visible when runtime synchronization fails and retry never imports it again', async t => {
  t.after(() => { failRestore = false; });
  const before = await db.exportData(), now = Date.now();
  const restored = { ...before, settings: { ...before.settings, targetScore: 35000, autoRecord: true, replayShortcut: 'F2' },
    phrases: [...before.phrases, { id: 'restored-phrase', text: 'ペアルック', reading: 'ぺあるっく', roman: 'pearukku', source: 'capture', confidence: 96, verified: true, capturedAt: now, lastSeenAt: now, seenCount: 1 }] };
  const file = new browser.File([JSON.stringify(restored)], 'restore-settings.json', { type: 'application/json' });
  const transfer = new browser.DataTransfer(); transfer.items.add(file);
  const open = document.querySelector<HTMLButtonElement>('[data-testid="nav-settings"]'); assert.ok(open);
  await act(async () => { open.click(); await delay(0); });
  const upload = document.querySelector<HTMLInputElement>('[data-testid="import-file"]'); assert.ok(upload);
  const notices = messages.filter(type => type === 'UCHI_SETTINGS_RESTORED').length;
  failRestore = true;
  await act(async () => { upload.files = transfer.files as unknown as FileList; upload.dispatchEvent(new browser.Event('change', { bubbles: true })); await delay(20); });
  await settle(() => Boolean(document.querySelector('[data-testid="retry-restored-settings"]')));
  const data = await db.getData();
  assert.equal(data.phrases.length, before.phrases.length + 1); assert.equal(data.settings.targetScore, 35000);
  assert.equal(data.settings.autoRecord, true); assert.equal(data.settings.replayShortcut, 'F2');
  assert.match(document.querySelector('.settings-data .microcopy')?.textContent ?? '', new RegExp(`${data.phrases.length}語`));
  assert.equal(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="number"]')?.value, '35000');
  assert.equal(document.querySelector<HTMLInputElement>('[role="switch"]')?.checked, true);
  assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '', /バックアップは読み込み済み.*記録設定/);
  assert.match(document.querySelector('.toast.success')?.textContent ?? '', /バックアップを読み込みました/);
  assert.equal(upload.value, '');
  assert.equal(messages.filter(type => type === 'UCHI_SETTINGS_RESTORED').length, notices + 1);
  await act(async () => { await db.updateSettings({ targetScore: 36000 }); await delay(20); });
  failRestore = false;
  const retry = document.querySelector<HTMLButtonElement>('[data-testid="retry-restored-settings"]'); assert.ok(retry);
  await act(async () => { retry.click(); await delay(20); });
  await settle(() => !document.querySelector('[role="dialog"]'));
  assert.equal(messages.filter(type => type === 'UCHI_SETTINGS_RESTORED').length, notices + 2);
  assert.equal((await db.getSettings()).targetScore, 36000, 'retry must not reapply the imported settings');
  assert.equal((await db.getData()).phrases[0].seenCount, 1);
  assert.equal(replayUpdates.at(-1), 'F2');
});

test('a durable pause exposes resume and an off switch even when the settings database still says enabled', async () => {
  await act(async () => { await db.updateSettings({ autoRecord: true }); publish({ state: 'idle', autoRecordPaused: true }); await delay(20); });
  const card = document.querySelector('[data-testid="capture-card"]'); assert.ok(card);
  assert.match(card.textContent ?? '', /自動記録を一時停止中/);
  assert.doesNotMatch(card.textContent ?? '', /開くだけで、記録/);
  const open = document.querySelector<HTMLButtonElement>('[data-testid="nav-settings"]'); assert.ok(open);
  await act(async () => { open.click(); await delay(0); });
  assert.equal(document.querySelector<HTMLInputElement>('[role="switch"]')?.checked, false);
  const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="閉じる"]'); assert.ok(close);
  await act(async () => { close.click(); await delay(0); });
  const before = messages.filter(type => type === 'UCHI_RESUME').length;
  const resume = [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('自動記録を再開')); assert.ok(resume);
  await act(async () => { resume.click(); await delay(20); });
  await settle(() => Boolean(card.textContent?.includes('自動記録を待機')));
  assert.equal(messages.filter(type => type === 'UCHI_RESUME').length, before + 1);
  assert.equal(status.autoRecordPaused, false);
  assert.equal((await db.getSettings()).autoRecord, true);
});
