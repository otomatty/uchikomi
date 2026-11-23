import test from 'node:test';
import assert from 'node:assert/strict';
import { closeObservedBoundary, PromptSignatureTracker, ResultFrameSequence } from '../src/capture/frame-lifecycle';
import { createCompletionBoundary, replayCapturedPhrase } from '../src/capture/key-boundary';
import { analyzeWords } from '../src/core/analytics';
import type { Phrase } from '../src/core/types';
import type { ParsedScore } from '../src/capture/score-parser';

const now = 1760000000000;
const signature = (offset: number) => { const bytes = new Uint8Array(100); bytes.fill(255, offset, offset + 10); return bytes; };
const a = signature(0), b = signature(20), c = signature(40);
const phrase: Phrase = { id: 'ika', text: 'いか', reading: 'いか', roman: 'ika', source: 'capture', confidence: 100, verified: true, capturedAt: now, lastSeenAt: now, seenCount: 1 };
const key = (value: string, at: number) => ({ key: value, at: now + at });

test('a replaced pending prompt breaks the predecessor anchor before the next stable word', () => {
  const tracker = new PromptSignatureTracker();
  tracker.observe(a, now); tracker.observe(a, now + 80);
  tracker.observe(b, now + 160); // This word is never observed twice.
  assert.equal(tracker.observe(c, now + 240).interruptedAt, now + 160);
  const successor = tracker.observe(c, now + 320).candidate!;
  assert.equal(successor.at, now + 240);
  assert.equal(successor.contiguous, false);
  const replay = replayCapturedPhrase({
    phrase, sessionId: 'game', observedAt: successor.at, endedAt: now + 400,
    // q belongs to the missed intermediate word; i preceded the new frame.
    strokes: [key('q', 175), key('i', 230), key('k', 280), key('a', 300)],
    contiguous: successor.contiguous, precedingCompletion: now + 100,
    observationReliable: true, focusGaps: [], accuracyMode: true,
  });
  assert.equal(replay.anchored, false);
  assert.equal(replay.attempt?.reliable, false);
  assert.deepEqual(analyzeWords([replay.attempt!]), []);
});

test('returning from a pending frame also breaks continuity; ordinary stable transitions retain it', () => {
  const tracker = new PromptSignatureTracker();
  assert.equal(tracker.observe(a, now).candidate, undefined);
  assert.equal(tracker.observe(a, now + 80).candidate?.contiguous, false);
  assert.equal(tracker.observe(a, now + 100).candidate, undefined);
  tracker.observe(b, now + 160);
  assert.equal(tracker.observe(b, now + 240).candidate?.contiguous, true);
  tracker.observe(c, now + 320);
  assert.equal(tracker.observe(b, now + 400).interruptedAt, now + 320);
  assert.equal(tracker.observe(b, now + 480).candidate?.contiguous, false);
  tracker.reset();
  tracker.observe(c, now + 560);
  assert.equal(tracker.observe(c, now + 640).candidate?.contiguous, false);
});

test('a confirmed receipt retains the last word, while an unknown disappearance excludes it', async () => {
  for (const observedExit of [true, false]) {
    const candidate = { reliableBoundary: true, completionBoundary: createCompletionBoundary(), endedAt: undefined as number | undefined };
    assert.equal(closeObservedBoundary(candidate, now + 350, observedExit), true);
    const replay = replayCapturedPhrase({
      phrase, sessionId: 'game', observedAt: now + 200, endedAt: candidate.endedAt!,
      strokes: [key('i', 225), key('k', 250), key('a', 300)],
      contiguous: candidate.reliableBoundary, precedingCompletion: now + 150,
      observationReliable: true, focusGaps: [], accuracyMode: true,
    });
    assert.equal(replay.attempt?.reliable, observedExit);
    assert.equal(analyzeWords([replay.attempt!]).length, observedExit ? 1 : 0);
    candidate.completionBoundary.settle(replay.completionAt);
    assert.equal(await candidate.completionBoundary.promise, observedExit ? now + 300 : null);
    // A subsequent region cleanup cannot alter an already closed observation.
    assert.equal(closeObservedBoundary(candidate, now + 500, false), false);
    assert.equal(candidate.endedAt, now + 350);
    assert.equal(candidate.reliableBoundary, observedExit);
  }
});

const score: ParsedScore = { kind: 'score', scoreType: 'total', score: 29740, total: 29740, confidence: 95, fingerprint: 'total:10000:accuracy:29740' };

test('an actually scanned blank breaks result agreement, including OCR queued before that blank', () => {
  for (const ocrBeforeBlank of [true, false]) {
    const frames = new ResultFrameSequence();
    const first = frames.scanned(true, now + 1000);
    if (ocrBeforeBlank) assert.equal(frames.observe(score, now + 1000, first), null);
    frames.scanned(false, now + 1600);
    if (!ocrBeforeBlank) assert.equal(frames.observe(score, now + 1000, first), null);
    const second = frames.scanned(true, now + 2200);
    assert.equal(frames.observe(score, now + 2200, second), null);
    const third = frames.scanned(true, now + 3400);
    assert.equal(frames.observe(score, now + 3400, third)?.score, 29740);
  }
});

test('interval skips supply no new observation and do not reset two real result frames', () => {
  const frames = new ResultFrameSequence();
  const first = frames.scanned(true, now + 1000);
  assert.equal(frames.observe(score, now + 1000, first), null);
  // The sampling loop makes no scanned() call while its scan interval is closed.
  const second = frames.scanned(true, now + 2200);
  assert.equal(second, first);
  assert.equal(frames.observe(score, now + 2200, second)?.score, 29740);
});
