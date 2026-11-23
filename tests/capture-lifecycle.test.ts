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
function captureSession(): Session {
  return {
    id: 'capture-game', captureId: 'capture-bridge', startedAt: now,
    source: 'capture', scoreType: 'profit', course: 10000, mode: 'accuracy',
    phraseCount: 1, correctKeys: 20, mistakes: 1, durationMs: 1000,
  };
}

test('a manual score readback cannot overwrite a later correction when capture stops', async () => {
  const live = captureSession();
  await saveSession(live);
  await saveSession({ ...live, score: 18000, scoreSource: 'manual' });

  // The OCR response arrives after manual edit A, while live counters have
  // already advanced beyond the database snapshot being read for notification.
  live.phraseCount = 4; live.correctKeys = 90; live.mistakes = 2;
  const readback = await saveCaptureScore(live, {
    score: 19740, scoreType: 'profit', scoreConfidence: 95,
    scoreObservedAt: now + 1000, scoreTotal: 29740, scoreProfit: 19740,
    scoreModeSource: 'configured', scoreEvidence: 'data:image/png;base64,AA==',
  });
  assert.equal(readback?.saved, false);
  assert.equal(readback?.latestScore.score, 18000);
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
  assert.equal(stopped.scoreProfit, 30000);
  assert.equal(stopped.scoreObservedAt, editB.scoreObservedAt);
  assert.equal(stopped.scoreConfidence, undefined);
  assert.equal(stopped.scoreEvidence, undefined);
  assert.equal(stopped.phraseCount, 5);
  assert.equal(stopped.correctKeys, 120);
  assert.equal(stopped.mistakes, 3);
  assert.equal(stopped.endedAt, live.endedAt);
  assert.equal(stopped.durationMs, 5000);
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
    storage: { session: {
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
  function resumeRecording(): Promise<any> {
    exists = true;
    return new Promise(resolve => {
      assert.equal(handler?.({ type: 'UCHI_OFF_STATE', status: recording }, { id: 'uchikomi-test', url: origin + 'offscreen.html' }, resolve), true);
    });
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
