import 'fake-indexeddb/auto';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearData, getData, saveSession } from '../src/core/db';
import type { CaptureStatus, Session } from '../src/core/types';
import { saveCaptureScore } from '../src/capture/score-persistence';

// Cross-context notifications are not part of these lifecycle regressions.
// Avoid keeping Node alive with a native BroadcastChannel.
const nativeChannel = globalThis.BroadcastChannel;
(globalThis as any).BroadcastChannel = undefined;
after(() => { globalThis.BroadcastChannel = nativeChannel; });
beforeEach(async () => { await clearData(); });

const now = 1760000000000;
function localStorageStub() {
  const values: Record<string, unknown> = {};
  return { async get() { return structuredClone(values); }, async set(value: Record<string, unknown>) { Object.assign(values, structuredClone(value)); } };
}
function captureSession(): Session {
  return {
    id: 'capture-game', captureId: 'capture-bridge', startedAt: now,
    source: 'capture', scoreType: 'total', course: 10000, mode: 'accuracy',
    phraseCount: 1, correctKeys: 20, mistakes: 1, durationMs: 1000,
  };
}

test('a manual score readback cannot overwrite a later correction when capture stops', async () => {
  const live = captureSession();
  await saveSession(live);
  await saveSession({ ...live, score: 28000, scoreSource: 'manual' });

  // The OCR response arrives after manual edit A, while live counters have
  // already advanced beyond the database snapshot being read for notification.
  live.phraseCount = 4; live.correctKeys = 90; live.mistakes = 2;
  const readback = await saveCaptureScore(live, {
    score: 29740, scoreType: 'total', scoreConfidence: 95,
    scoreObservedAt: now + 1000, scoreTotal: 29740,
    scoreModeSource: 'configured', scoreEvidence: 'data:image/png;base64,AA==',
  });
  assert.equal(readback?.saved, false);
  assert.equal(readback?.latestScore.score, 28000);
  assert.equal(readback?.latestScore.scoreType, 'total');
  assert.equal(live.scoreSource, undefined);
  assert.equal(live.score, undefined);
  assert.equal(live.correctKeys, 90);

  // The user then makes edit B before finishStop's final counter/session write.
  const editA = (await getData()).sessions[0];
  await saveSession({ ...editA, score: 40000, scoreType: 'total', scoreSource: 'manual' });
  const editB = (await getData()).sessions[0];
  live.phraseCount = 5; live.correctKeys = 120; live.mistakes = 3;
  live.endedAt = now + 5000; live.durationMs = 5000;
  await saveSession(live);

  const stopped = (await getData()).sessions[0];
  assert.equal(stopped.score, 40000);
  assert.equal(stopped.scoreType, 'total');
  assert.equal(stopped.scoreSource, 'manual');
  assert.equal(stopped.scoreTotal, 40000);
  assert.equal(Object.hasOwn(stopped, 'scoreProfit'), false);
  assert.equal(stopped.scoreObservedAt, editB.scoreObservedAt);
  assert.equal(stopped.scoreConfidence, undefined);
  assert.equal(stopped.scoreEvidence, undefined);
  assert.equal(stopped.phraseCount, 5);
  assert.equal(stopped.correctKeys, 120);
  assert.equal(stopped.mistakes, 3);
  assert.equal(stopped.endedAt, live.endedAt);
  assert.equal(stopped.durationMs, 5000);
});

test('capture persists and announces the food total and rejects the removed score basis', async () => {
  const live = captureSession();
  await saveSession(live);
  const patch = { score: 29740, scoreType: 'total' as const, scoreConfidence: 95, scoreObservedAt: now + 1000, scoreTotal: 29740 };
  const result = await saveCaptureScore(live, patch);
  assert.equal(result?.saved, true);
  assert.equal(result?.latestScore.score, 29740);
  assert.equal(result?.latestScore.scoreType, 'total');
  const stored = (await getData()).sessions[0];
  assert.equal(stored.score, 29740); assert.equal(stored.scoreTotal, 29740);
  assert.equal(Object.hasOwn(stored, 'scoreProfit'), false);
  assert.equal(Object.hasOwn(live, 'scoreProfit'), false);
  await assert.rejects(saveCaptureScore(live, { ...patch, score: 19740, scoreType: 'profit' } as any), /合計/);
  assert.deepEqual((await getData()).sessions[0], stored);
});

test('background stop propagates offscreen save failure, cleans up, and permits another recording', async t => {
  const originalChrome = globalThis.chrome;
  const published: CaptureStatus[] = [];
  const tabMessages: unknown[] = [];
  const calls: string[] = [];
  let closeCount = 0;
  let exists = true;
  let offscreenResponse: unknown = { ok: false, error: '記録を保存できませんでした（容量不足）。' };
  let handler: ((message: unknown, sender: unknown, sendResponse: (value: any) => void) => unknown) | undefined;
  const origin = 'chrome-extension://uchikomi-test/';
  const recording: CaptureStatus = {
    state: 'recording', tabId: 7, sessionId: 'capture-bridge',
    activeSessionId: 'capture-game', startedAt: now, phraseCount: 5, ocrReady: true,
  };
  const ignoreListener = { addListener() {} };
  (globalThis as any).chrome = {
    runtime: {
      id: 'uchikomi-test', getURL: (path: string) => origin + path,
      onInstalled: ignoreListener,
      onMessage: { addListener(listener: typeof handler) { handler = listener; } },
      async getContexts() { return exists ? [{}] : []; },
      async sendMessage(message: any) {
        if (message.target === 'offscreen') {
          calls.push(message.type);
          if (message.type === 'UCHI_OFF_STOP') return offscreenResponse;
          throw new Error('Unexpected offscreen message: ' + message.type);
        }
        return { ok: true };
      },
    },
    storage: { local: localStorageStub(), session: {
      async get() { return { captureStatus: recording }; },
      async set(value: { captureStatus?: CaptureStatus }) {
        if (value.captureStatus) published.push(structuredClone(value.captureStatus));
      },
    } },
    action: {
      onClicked: ignoreListener, async setBadgeText() {}, async setBadgeBackgroundColor() {},
    },
    tabs: {
      onRemoved: ignoreListener, onUpdated: ignoreListener,
      async sendMessage(_id: number, message: unknown) { tabMessages.push(message); return { ok: true }; },
    },
    tabCapture: { onStatusChanged: ignoreListener },
    offscreen: { async closeDocument() { closeCount++; exists = false; } },
  };
  t.after(() => { (globalThis as any).chrome = originalChrome; });
  await import('../src/capture/background');

  function requestStop(): Promise<any> {
    return new Promise(resolve => {
      assert.equal(handler?.({ type: 'UCHI_STOP' }, { id: 'uchikomi-test', url: origin + 'sidepanel.html' }, resolve), true);
    });
  }
  let recordingNumber = 0;
  async function resumeRecording(): Promise<void> {
    exists = true;
    // A fresh service worker recovers a real current capture from storage.
    // A late OFF_STATE message can no longer revive an ended recording.
    await import(`../src/capture/background.ts?stop-save-${++recordingNumber}`);
  }

  const failed = await requestStop();
  assert.equal(failed.ok, false);
  assert.equal(failed.error, '記録を保存できませんでした（容量不足）。');
  assert.equal(failed.status.state, 'error');
  assert.deepEqual(published.map(status => status.state), ['stopping', 'error']);
  assert.deepEqual(tabMessages, [{ type: 'UCHI_CAPTURE_DISABLE' }]);
  assert.equal(closeCount, 1);
  assert.equal(exists, false);

  // Missing/malformed replies must also fail closed, without a successful idle
  // notification. Each iteration models a new recording, not retrying lost data.
  for (const response of [undefined, {}, { ok: false }, { ok: false, error: 'x'.repeat(200) }]) {
    await resumeRecording();
    published.length = 0;
    offscreenResponse = response;
    const missing = await requestStop();
    assert.equal(missing.ok, false);
    assert.equal(missing.status.state, 'error');
    assert.match(missing.error, /最後の記録を保存できませんでした/);
    assert.deepEqual(published.map(status => status.state), ['stopping', 'error']);
    assert.equal(exists, false);
  }

  // The transition lock is released after failure, so a subsequent recording
  // can stop successfully, but only following an explicit successful reply.
  await resumeRecording();
  published.length = 0;
  offscreenResponse = { ok: true, status: { ...recording, state: 'idle', ocrReady: false }, sessionId: 'capture-game' };
  const succeeded = await requestStop();
  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.status.state, 'idle');
  assert.equal(succeeded.sessionId, 'capture-game');
  assert.deepEqual(published.map(status => status.state), ['stopping', 'idle']);
  assert.equal(closeCount, 6);
  assert.equal(calls.filter(type => type === 'UCHI_OFF_STOP').length, 6);
});

test('initial status-read failure releases both start and stop transition locks', async t => {
  const originalChrome = globalThis.chrome;
  t.after(() => { (globalThis as any).chrome = originalChrome; });
  for (const action of ['UCHI_START', 'UCHI_STOP']) {
    let failStatusRead = true;
    let handler: ((message: unknown, sender: unknown, sendResponse: (response: any) => void) => unknown) | undefined;
    const origin = `chrome-extension://lock-${action.toLowerCase()}/`;
    const id = `lock-${action.toLowerCase()}`;
    const ignored = { addListener() {} };
    (globalThis as any).chrome = {
      runtime: {
        id, getURL: (path: string) => origin + path,
        onInstalled: ignored, onMessage: { addListener(listener: typeof handler) { handler = listener; } },
        async getContexts() { return []; }, async sendMessage() { return { ok: true }; },
      },
      storage: { local: localStorageStub(), session: {
        async get() {
          if (failStatusRead) { failStatusRead = false; throw new Error('temporary session-storage failure'); }
          return {};
        },
        async set() {},
      } },
      action: { onClicked: ignored, async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      tabs: { onRemoved: ignored, onUpdated: ignored, async query() { return []; } },
      tabCapture: { onStatusChanged: ignored }, offscreen: { async closeDocument() {} },
    };
    // A separate service-worker module instance for each initial failure path.
    await import(`../src/capture/background.ts?lock-test=${action}`);
    const request = () => new Promise<any>(resolve => {
      assert.equal(handler?.({ type: action }, { id, url: origin + 'sidepanel.html' }, resolve), true);
    });
    const first = await request();
    assert.equal(first.ok, false);
    assert.equal(first.error, 'temporary session-storage failure');
    const retry = await request();
    if (action === 'UCHI_START') assert.equal(retry.error, '寿司打のタブを開いて、拡張アイコンを押してください。');
    else assert.equal(retry.ok, true);
  }
});

test('background drops legacy score notifications without relabelling them or changing capture state', async t => {
  const originalChrome = globalThis.chrome;
  t.after(() => { (globalThis as any).chrome = originalChrome; });
  const id = 'total-status-test', origin = `chrome-extension://${id}/`;
  const ignored = { addListener() {} };
  const legacy = { sessionId: 'previous-game', score: 19740, scoreType: 'profit', confidence: 95 };
  const stored = { state: 'recording', phraseCount: 8, sessionId: 'bridge', tabId: 7, latestScore: legacy };
  let live: any = { ...stored, state: 'recording', tabId: 7 };
  const published: any[] = [];
  let handler: ((message: any, sender: any, reply: (result: any) => void) => unknown) | undefined;
  (globalThis as any).chrome = {
    runtime: {
      id, getURL: (path: string) => origin + path, onInstalled: ignored,
      onMessage: { addListener(listener: typeof handler) { handler = listener; } },
      async getContexts() { return [{}]; },
      async sendMessage(message: any) { return message.type === 'UCHI_OFF_STATUS' ? { ok: true, status: live } : { ok: true }; },
    },
    storage: { local: localStorageStub(), session: { async get() { return { captureStatus: stored }; }, async set(value: any) { published.push(structuredClone(value.captureStatus)); } } },
    action: { onClicked: ignored, async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: { onRemoved: ignored, onUpdated: ignored, async sendMessage() { return { ok: true }; } },
    tabCapture: { onStatusChanged: ignored }, offscreen: { async closeDocument() {} },
  };
  await import('../src/capture/background.ts?total-notification-test');
  const request = (message: any, from = 'sidepanel.html') => new Promise<any>(resolve => {
    assert.equal(handler?.(message, { id, url: origin + from }, resolve), true);
  });
  const cached = await request({ type: 'UCHI_STATUS' });
  assert.equal(cached.status.state, 'recording'); assert.equal(cached.status.latestScore, undefined);
  assert.equal(cached.status.phraseCount, 8); assert.equal(cached.status.sessionId, 'bridge');
  await request({ type: 'UCHI_OFF_STATE', status: live }, 'offscreen.html');
  assert.equal(published.at(-1).state, 'recording'); assert.equal(published.at(-1).latestScore, undefined);
  const refreshed = await request({ type: 'UCHI_STATUS' });
  assert.equal(refreshed.status.state, 'recording'); assert.equal(refreshed.status.latestScore, undefined);
  live = { ...live, latestScore: { ...legacy, score: 29740, scoreType: 'total' } };
  const current = await request({ type: 'UCHI_STATUS' });
  assert.equal(current.status.state, 'recording'); assert.equal(current.status.latestScore.score, 29740);
  assert.equal(current.status.latestScore.scoreType, 'total');
});
