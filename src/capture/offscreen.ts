import { PSM, type Worker as OcrWorker } from 'tesseract.js';
import { saveAttempt, savePhrase, saveSession } from '../core/db';
import { TrainingActivity } from '../core/activity';
import type { Calibration, CaptureStatus, KeyStroke, Phrase, Rect, Session, Settings } from '../core/types';
import { EMPTY_CAPTURE } from '../core/types';
import { isCalibration, MAX_CANDIDATES, MAX_KEY_BUFFER, normalizeJapanese, normalizeOcrRoman, pixelRect, preprocessOcrPixels, SAMPLE_MS, signatureDistance, unionRects, validJapanese, validRoman } from './helpers';
import { detectPromptRegions, type AutoRegions } from './auto-region';
import { resolveOcrReading } from './ocr-reading';
import { detectResultRegions, findAmountRect, preprocessResultPixels } from './auto-result';
import { parseResultScore, type NumericScoreText, type ParsedScore } from './score-parser';
import { createCompletionBoundary, replayCapturedPhrase, type CompletionBoundary } from './key-boundary';
import { saveCaptureScore } from './score-persistence';
import { closeObservedBoundary, PromptSignatureTracker, ResultFrameSequence } from './frame-lifecycle';
import { startOcrWorkers } from './ocr-worker';

interface CanvasFrame {
  dataUrl: string; width: number; height: number; at: number; sequence: number;
}

interface ReplayFrame {
  source: 'canvas' | 'tab'; width: number; height: number; at: number;
  panel: Rect; header: Uint8Array; total: Uint8Array;
}
interface ReplayRequest {
  game: CaptureGame; captureId: string; token: number; initial: ReplayFrame;
  cancelled: boolean; cancel(reason: string): void;
}
interface ActivityWindow { from: number; through: number; until?: number; }
interface ActivityOccurrence { id: string; from: number; until?: number; counted?: boolean; }
interface CaptureGame {
  activity: TrainingActivity; activityWindows: ActivityWindow[]; activityWindow?: ActivityWindow;
  activityLastWindow?: ActivityWindow; activityResumeAfter: number;
  activityKeys: Set<string>; activityStrokes: KeyStroke[]; activityOccurrences: ActivityOccurrence[];
  activityRevision: number; savedActivityRevision: number; activityCheckpoint?: Promise<void>;
  session: Session; writes: Promise<void>; observedPrompt: boolean; resultSeen: boolean; scoreSaved: boolean;
  reader: ResultFrameSequence; lastResult?: { parsed: ParsedScore; at: number; evidence: string };
}
interface ResultCandidate {
  game: CaptureGame; at: number; header: HTMLCanvasElement; total: HTMLCanvasElement;
  paid: HTMLCanvasElement; profit: HTMLCanvasElement; confidence: number; screenshot: string; revision: number;
}

interface Candidate {
  game: CaptureGame;
  precedingBoundary?: CompletionBoundary; completionBoundary: CompletionBoundary;
  activityOccurrence?: ActivityOccurrence;
  id: number; at: number; endedAt?: number;
  japanese: HTMLCanvasElement; reading?: HTMLCanvasElement; roman: HTMLCanvasElement;
  screenshot: string; signature: Uint8Array; phrase?: Phrase;
  processed: boolean; finalized: boolean; reliableBoundary: boolean; observationReliable: boolean;
}

let status: CaptureStatus = { ...EMPTY_CAPTURE };
let stream: MediaStream | null = null;
const video = document.createElement('video');
video.muted = true; video.playsInline = true;
document.body.append(video);
// Canvas recording receives only the game image from its owning content script.
// Keep one decoded frame in memory; OCR persistence still uses cropped evidence.
const externalCanvas = document.createElement('canvas');
const externalContext = externalCanvas.getContext('2d', { willReadFrequently: true })!;
let lastCanvasAt = 0;
let lastCanvasSequence = -1;
let pendingCanvasDecode: AbortController | null = null;
let lastCanvasResultSequence = -1;
let lastCanvasResultFound = false;
let lastTabFrameAt = 0, lastTabPresentation = -1, lastTabDecoded = -1;
let tabFrameCallback: number | undefined;
let replayRequest: ReplayRequest | null = null;
let lastReplayGrant: { game: CaptureGame; at: number } | null = null;
let calibration: Calibration | undefined;
let settings: Settings | null = null;
let jpWorker: OcrWorker | null = null;
let romanWorker: OcrWorker | null = null;
let initializing: Promise<void> | null = null;
let initializationController: AbortController | null = null;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let activityTimer: ReturnType<typeof setInterval> | undefined;
let keyBuffer: KeyStroke[] = [];
let seenKeyEvents = new Set<string>();
let focusGaps: number[] = [];
let queue: Candidate[] = [];
let scoreQueue: ResultCandidate[] = [];
let currentCandidate: Candidate | undefined;
let processing: Promise<void> | null = null;
const promptSignatures = new PromptSignatureTracker();
let sequence = 0;
let generation = 0;
let stopped = false;
let stopTask: Promise<unknown> | null = null;
const pendingWrites = new Set<Promise<void>>();
let session: Session | null = null;
let activeGame: CaptureGame | null = null;
let games: CaptureGame[] = [];
let lastResultScan = 0;
let lastPublish = 0;
let manualRegions = false;
let detectedRegions: AutoRegions | null = null;
let lastRegionScan = 0;
let captureWarning: string | undefined;
let lastFrameWidth = 0;
let lastFrameHeight = 0;
const detectCanvas = document.createElement('canvas');
detectCanvas.width = 192; detectCanvas.height = 32;
const detectContext = detectCanvas.getContext('2d', { willReadFrequently: true })!;
const regionCanvas = document.createElement('canvas');
const regionContext = regionCanvas.getContext('2d', { willReadFrequently: true })!;
const REGION_SCAN_MS = 240;
const RESULT_SCAN_MS = 1200;
const MAX_CANVAS_GAP_MS = 300;
const MAX_CANVAS_DATA_LENGTH = 3_000_000;
const CANVAS_DECODE_TIMEOUT_MS = 3000;
const CANVAS_JPEG_PREFIX = 'data:image/jpeg;base64,';
const REPLAY_MAX_FRAME_AGE_MS = 1000, REPLAY_DEADLINE_MS = 8000, REPLAY_COOLDOWN_MS = 1000;
const ROMAN_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,-'/():;[]";

function frameSurface() {
  return status.source === 'canvas'
    ? { image: externalCanvas, width: externalCanvas.width, height: externalCanvas.height, ready: lastCanvasAt > 0 }
    : { image: video, width: video.videoWidth, height: video.videoHeight, ready: video.readyState >= 2 };
}

function announce(patch: Partial<CaptureStatus> = {}) {
  status = { ...status, ...patch };
  lastPublish = Date.now();
  void chrome.runtime.sendMessage({ type: 'UCHI_OFF_STATE', status }).catch(() => {});
}
function makeGame(at: number, id: string = crypto.randomUUID()): CaptureGame {
  replayRequest?.cancel('ゲームが切り替わりました。');
  const data: Session = {
    id, captureId: status.sessionId, startedAt: at, source: 'capture', scoreType: 'total',
    course: 10000, mode: 'accuracy', phraseCount: 0, correctKeys: 0, mistakes: 0, durationMs: 0, activity: [],
  };
  const game: CaptureGame = {
    session: data, writes: saveSession(data), observedPrompt: false, resultSeen: false, scoreSaved: false, reader: new ResultFrameSequence(),
    activity: new TrainingActivity(), activityWindows: [], activityResumeAfter: 0, activityKeys: new Set(), activityStrokes: [], activityOccurrences: [],
    activityRevision: 0, savedActivityRevision: 0,
  };
  // Every queued OCR job keeps its own game, so a quick retry cannot attach an
  // old phrase or result to the next game in the same continuous recording.
  games.push(game); activeGame = game; session = data;
  void game.writes.catch(reportError);
  announce({ activeSessionId: id, scoreState: 'watching', scoreReviewSessionId: undefined });
  return game;
}
function persistGame(game: CaptureGame): Promise<void> {
  game.writes = game.writes.catch(() => {}).then(async () => {
    const revision = game.activityRevision;
    game.session.activity = game.activity.snapshot();
    await saveSession(game.session);
    game.savedActivityRevision = Math.max(game.savedActivityRevision, revision);
  });
  return game.writes;
}
function physicalKeyId(key: KeyStroke): string { return `${key.at}\0${key.code ?? ''}\0${key.key.toLowerCase()}`; }
function recordActivityOccurrence(game: CaptureGame, occurrence: ActivityOccurrence) {
  if (occurrence.counted) return;
  const key = game.activityStrokes.find(stroke => stroke.at >= occurrence.from && (occurrence.until === undefined || stroke.at < occurrence.until));
  if (!key) return;
  game.activity.recordPhrase(occurrence.id, key.at); occurrence.counted = true; game.activityRevision++;
}
function recordObservedActivity(game: CaptureGame, keys = keyBuffer) {
  // A buffered key contributes only after an actual prompt frame has confirmed
  // its time window. Start-menu/result keys outside that window stay excluded.
  const pending = keys.filter(key => key.at >= game.session.startedAt && !game.activityKeys.has(physicalKeyId(key))).sort((a, b) => a.at - b.at);
  for (const key of pending) {
    const window = game.activityWindows.find(value => key.at >= value.from && key.at <= value.through && (value.until === undefined || key.at < value.until));
    if (!window) continue;
    if (game.activityLastWindow !== window) game.activity.break();
    game.activityLastWindow = window;
    game.activity.recordKey(key.at); game.activityKeys.add(physicalKeyId(key)); game.activityStrokes.push(key); game.activityRevision++;
    const occurrence = game.activityOccurrences.find(value => key.at >= value.from && (value.until === undefined || key.at < value.until));
    if (occurrence) recordActivityOccurrence(game, occurrence);
  }
}
function confirmActivityPrompt(game: CaptureGame, at: number) {
  if (game.resultSeen || at < game.activityResumeAfter) return;
  if (!game.activityWindow) {
    game.activityWindow = { from: at, through: at };
    game.activityWindows.push(game.activityWindow);
  } else game.activityWindow.through = Math.max(game.activityWindow.through, at);
  recordObservedActivity(game);
}
function breakActivity(game: CaptureGame | null, at: number) {
  if (!game) return;
  if (game.activityWindow) {
    game.activityWindow.until = at;
    game.activityWindow.through = Math.min(game.activityWindow.through, at);
    game.activityWindow = undefined;
  }
  game.activityResumeAfter = Math.max(game.activityResumeAfter, at);
  game.activityLastWindow = undefined;
  game.activity.break();
}
function checkpointActivity() {
  for (const game of games) {
    if (game.activityRevision <= game.savedActivityRevision || game.activityCheckpoint) continue;
    const task = persistGame(game).catch(reportError);
    game.activityCheckpoint = task;
    void task.finally(() => { if (game.activityCheckpoint === task) game.activityCheckpoint = undefined; });
  }
}
function observePrompt(at: number) {
  if (!activeGame || activeGame.resultSeen) {
    const previous = activeGame;
    makeGame(at, !games.length && status.source === 'canvas' ? status.sessionId : undefined);
    if (previous && !previous.scoreSaved && previous.lastResult) {
      const last = previous.lastResult;
      void reviewScore(previous, last.parsed, last.at, last.evidence,
        last.parsed.kind === 'score' ? '2回の一致を確認する前に次のゲームが始まりました' : undefined).catch(reportError);
    }
  }
  activeGame!.observedPrompt = true;
  confirmActivityPrompt(activeGame!, at);
}
function crop(rect: Rect, upscale = false): HTMLCanvasElement {
  const frame = frameSurface();
  const area = pixelRect(rect, frame.width, frame.height);
  const scale = upscale ? Math.min(3, Math.max(2, 56 / area.height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.width * scale));
  canvas.height = Math.max(1, Math.round(area.height * scale));
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(frame.image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function ocrCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  // Unify text colors without touching the live WebGL canvas.
  const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
  const context = output.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(canvas, 0, 0);
  const image = context.getImageData(0, 0, output.width, output.height);
  preprocessOcrPixels(image.data, output.width, output.height);
  context.putImageData(image, 0, 0);
  return output;
}
function imageSignature(rect: Rect): { bytes: Uint8Array; ink: number } {
  const frame = frameSurface();
  const area = pixelRect(rect, frame.width, frame.height);
  detectContext.drawImage(frame.image, area.x, area.y, area.width, area.height, 0, 0, detectCanvas.width, detectCanvas.height);
  const image = detectContext.getImageData(0, 0, detectCanvas.width, detectCanvas.height).data;
  const bytes = new Uint8Array(detectCanvas.width * detectCanvas.height);
  let ink = 0;
  let border = 0;
  for (let x = 0; x < detectCanvas.width; x++) border += (image[x * 4] + image[x * 4 + 1] + image[x * 4 + 2]) / 3;
  const inverted = border / detectCanvas.width < 125;
  for (let i = 0; i < bytes.length; i++) {
    const pixel = i * 4;
    let gray = (image[pixel] + image[pixel + 1] + image[pixel + 2]) / 3;
    if (inverted) gray = 255 - gray;
    // Binary shapes are insensitive to antialiasing and minor frame flicker.
    bytes[i] = gray < 175 ? 255 : 0;
    if (bytes[i]) ink++;
  }
  return { bytes, ink: ink / bytes.length };
}
async function finalizeCandidate(candidate: Candidate) {
  if (candidate.finalized || !candidate.processed || !candidate.endedAt) return;
  candidate.finalized = true;
  try {
    if (!candidate.phrase) return;
    const game = candidate.game;
    await game.writes;
    // A final key may still be in the content script's 90 ms batch.
    const settle = candidate.endedAt + 200 - Date.now();
    if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle));
    const precedingCompletion = candidate.precedingBoundary ? await candidate.precedingBoundary.promise : null;
    const { attempt, completionAt } = replayCapturedPhrase({
      phrase: candidate.phrase, strokes: keyBuffer, observedAt: candidate.at, endedAt: candidate.endedAt,
      sessionId: game.session.id, contiguous: candidate.reliableBoundary, precedingCompletion,
      observationReliable: candidate.observationReliable, focusGaps, accuracyMode: game.session.mode === 'accuracy',
    });
    if (!attempt) return;
    await saveAttempt(attempt);
    if (attempt.reliable) {
      game.session.correctKeys += attempt.correctKeys;
      game.session.mistakes += attempt.mistakes;
      await persistGame(game);
    }
    candidate.completionBoundary.settle(completionAt);
  } finally {
    // Every skipped/error path settles the handoff so stop() and later words
    // can never wait forever for an OCR result that will not arrive.
    candidate.completionBoundary.settle(null);
    candidate.precedingBoundary = undefined;
    candidate.japanese.width = 1; candidate.roman.width = 1;
    if (candidate.reading) candidate.reading.width = 1;
  }
}
function endCurrent(at: number, observedExit = true) {
  if (!currentCandidate || !closeObservedBoundary(currentCandidate, at, observedExit)) return;
  if (currentCandidate.activityOccurrence) currentCandidate.activityOccurrence.until = at;
  if (currentCandidate.processed) {
    const write = finalizeCandidate(currentCandidate).catch(reportError);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  }
}
function resetAutoRegions(at: number, publish = true, confirmedResult = false) {
  breakActivity(activeGame, at);
  // An unknown loss makes the attempt's end uncertain. A detected receipt is
  // an observed game-end transition and retains the final phrase's boundary.
  endCurrent(at, confirmedResult);
  if (!confirmedResult) currentCandidate?.completionBoundary.settle(null);
  calibration = undefined;
  detectedRegions = null;
  manualRegions = false;
  lastRegionScan = 0;
  promptSignatures.reset();
  if (publish) announce({ regionState: 'searching', regionConfidence: undefined, region: undefined, message: captureWarning ?? (status.ocrReady ? 'お題を探しています' : '文字認識を準備しています') });
}
function panelMoved(previous: Rect, next: Rect): boolean {
  const frame = frameSurface();
  const tolerance = Math.max(3, previous.height * frame.height * .025);
  return Math.abs(previous.x - next.x) * frame.width > tolerance ||
    Math.abs(previous.y - next.y) * frame.height > tolerance ||
    Math.abs(previous.width - next.width) * frame.width > tolerance ||
    Math.abs(previous.height - next.height) * frame.height > tolerance;
}
function scanRegions(now: number) {
  if (manualRegions || now - lastRegionScan < REGION_SCAN_MS) return;
  lastRegionScan = now;
  // OCR still uses the original-resolution frame. Only the inexpensive frame
  // locator is reduced, keeping large displays from blocking the sample loop.
  const surface = frameSurface();
  const scale = Math.min(1, 1280 / Math.max(surface.width, surface.height));
  const width = Math.max(1, Math.round(surface.width * scale));
  const height = Math.max(1, Math.round(surface.height * scale));
  if (regionCanvas.width !== width || regionCanvas.height !== height) {
    regionCanvas.width = width; regionCanvas.height = height;
  }
  regionContext.drawImage(surface.image, 0, 0, width, height);
  const frame = regionContext.getImageData(0, 0, width, height);
  const found = detectPromptRegions(frame);
  if (!found) {
    // Check the same disappearance frame for a receipt before treating it as
    // an unknown loss. A normal result transition must retain the final word.
    if (collectResultFrame(now, Boolean(calibration), frame)) return;
    if (calibration || status.regionState !== 'searching') resetAutoRegions(now);
    return;
  }
  observePrompt(now);
  if (detectedRegions && !panelMoved(detectedRegions.panel, found.panel)) return;
  // Do not let image-location jitter masquerade as a new phrase. A meaningful
  // movement starts a fresh observation and is reacquired without user input.
  if (detectedRegions) resetAutoRegions(now, false);
  detectedRegions = found;
  calibration = {
    japanese: found.japanese, reading: found.reading, roman: found.roman,
    viewport: { width: surface.width, height: surface.height }, updatedAt: now,
  };
  announce({ regionState: 'locked', regionConfidence: found.confidence, region: found.panel, message: captureWarning ?? (status.ocrReady ? 'お題を自動検出しました' : '文字認識を準備しています') });
}
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  captureWarning = /quota|storage/i.test(message) ? '保存領域が不足しています。記録を停止してデータを書き出してください。' : '一部のお題の読み取り・保存に失敗しました。';
  announce({ message: captureWarning });
}
function candidateFromFrame(at: number, signature: Uint8Array, reliableBoundary: boolean): Candidate {
  const c = calibration!;
  const bounds = unionRects([c.japanese, c.roman, ...(c.reading ? [c.reading] : [])]);
  const evidence = crop(bounds);
  const id = ++sequence, activityOccurrence = { id: `${activeGame!.session.id}:${id}`, from: at };
  activeGame!.activityOccurrences.push(activityOccurrence);
  recordActivityOccurrence(activeGame!, activityOccurrence);
  return {
    game: activeGame!, completionBoundary: createCompletionBoundary(),
    precedingBoundary: reliableBoundary && currentCandidate?.game === activeGame ? currentCandidate.completionBoundary : undefined,
    id, at, activityOccurrence, japanese: crop(c.japanese, true), reading: c.reading ? crop(c.reading, true) : undefined,
    roman: crop(c.roman, true), screenshot: evidence.toDataURL('image/jpeg', .84), signature,
    processed: false, finalized: false, reliableBoundary, observationReliable: false,
  };
}
function sampleFrame(now = Date.now()) {
  const frame = frameSurface();
  if (stopped || status.state !== 'recording' || !frame.ready || !frame.width || !frame.height) return;
  if (status.source === 'tab' && typeof video.getVideoPlaybackQuality === 'function') {
    const decoded = video.getVideoPlaybackQuality().totalVideoFrames;
    if (decoded > 0 && decoded > lastTabDecoded) { lastTabDecoded = decoded; lastTabFrameAt = now; }
  }
  if (frame.width !== lastFrameWidth || frame.height !== lastFrameHeight) {
    if (lastFrameWidth && lastFrameHeight) resetAutoRegions(now);
    lastFrameWidth = frame.width; lastFrameHeight = frame.height;
  }
  // A manual rectangle over an old receipt is not evidence of a new game.
  // Result detection already clears the override; this also covers a fresh
  // manual adjustment made while that same receipt is still on screen.
  if (manualRegions && activeGame?.resultSeen) resetAutoRegions(now);
  scanRegions(now);
  if ((!calibration || manualRegions) && collectResultFrame(now)) return;
  if (!status.ocrReady || !calibration) return;
  const { bytes, ink } = imageSignature(calibration.japanese);
  if (ink < .006 || ink > .85) {
    if (collectResultFrame(now, true)) return;
    breakActivity(activeGame, now);
    currentCandidate?.completionBoundary.settle(null);
    endCurrent(now, false);
    promptSignatures.reset();
    return;
  }
  if (manualRegions) observePrompt(now);
  const transition = promptSignatures.observe(bytes, now);
  if (transition.interruptedAt !== undefined) endCurrent(transition.interruptedAt);
  if (!transition.candidate) return;
  // The frame epoch is retained here. OCR completion never becomes a boundary.
  // The first phrase after start/reacquisition may already be partly typed.
  // Only an uninterrupted, observed transition establishes a reliable start.
  const { at, contiguous } = transition.candidate;
  endCurrent(at);
  const candidate = candidateFromFrame(at, bytes, contiguous);
  currentCandidate = candidate;
  if (queue.length >= MAX_CANDIDATES) {
    queue.shift()?.completionBoundary.settle(null); candidate.reliableBoundary = false;
    captureWarning = '読み取りが混み合い、一部のお題を記録できませんでした。';
    announce({ message: captureWarning });
  }
  queue.push(candidate);
  void processQueue();
  if (now - lastPublish > 4000) announce({ lastFrameAt: now });
}

async function recognize(candidate: Candidate) {
  if (!jpWorker || !romanWorker) return;
  const [jpResult, romanResult] = await Promise.all([
    jpWorker.recognize(ocrCanvas(candidate.japanese)),
    romanWorker.recognize(ocrCanvas(candidate.roman)),
  ]);
  let readingResult: { text: string; confidence: number } | null = null;
  if (candidate.reading) {
    const result = await jpWorker.recognize(ocrCanvas(candidate.reading));
    readingResult = result.data;
  }
  const text = normalizeJapanese(jpResult.data.text);
  const roman = normalizeOcrRoman(romanResult.data.text);
  if (!validJapanese(text) || !validRoman(roman) || jpResult.data.confidence < 45 || romanResult.data.confidence < 55) return;
  // Menu labels are not practice phrases. Genuine Japanese+roman pairs are required.
  if (/^(スタート|ランキング|タイトル|設定|ヘルプ|メニュー|終了|もう一度|正確重視|高級|お手軽|お勧め|お得|損|平均キー)/.test(text)) return;
  const resolved = resolveOcrReading({
    japanese: text, roman, reading: readingResult?.text ?? '',
    japaneseConfidence: jpResult.data.confidence, romanConfidence: romanResult.data.confidence,
    readingConfidence: readingResult?.confidence ?? 0,
  });
  const confidence = Math.round(Math.min(jpResult.data.confidence, romanResult.data.confidence, resolved.confidence));
  const verified = confidence >= 82 && jpResult.data.confidence >= 85 && romanResult.data.confidence >= 88 && resolved.consistent;
  // Historical confirmation of a canonical phrase must not upgrade this frame's OCR.
  candidate.observationReliable = verified;
  const phrase = await savePhrase({
    id: crypto.randomUUID(), text, reading: resolved.reading, roman,
    source: 'capture', confidence, verified, capturedAt: candidate.at, lastSeenAt: candidate.at, seenCount: 1,
    screenshot: candidate.screenshot, tags: resolved.source === 'title' ? ['よみを表記から確認'] : undefined,
  });
  candidate.phrase = phrase;
  candidate.game.session.phraseCount++; await persistGame(candidate.game);
  announce({ phraseCount: (status.phraseCount ?? 0) + 1, latestPhrase: phrase.text, lastFrameAt: candidate.at, message: captureWarning });
}

function collectResultFrame(now: number, force = false, observedFrame?: ImageData): boolean {
  const game = activeGame;
  // Starting a recording on an old result must not create another score. A
  // genuine prompt has to have been visible during this recording first.
  const surface = frameSurface();
  if (!game?.observedPrompt || game.scoreSaved || !status.ocrReady || !surface.ready || !surface.width) return false;
  // One external image is one observation, even if multiple detection paths
  // request a forced scan while handling that same frame.
  if (status.source === 'canvas' && lastCanvasResultSequence === lastCanvasSequence) return lastCanvasResultFound;
  if (!force && now - lastResultScan < RESULT_SCAN_MS) return false;
  lastResultScan = now;
  if (!observedFrame) {
    const scale = Math.min(1, 1280 / Math.max(surface.width, surface.height));
    regionCanvas.width = Math.max(1, Math.round(surface.width * scale));
    regionCanvas.height = Math.max(1, Math.round(surface.height * scale));
    regionContext.drawImage(surface.image, 0, 0, regionCanvas.width, regionCanvas.height);
    observedFrame = regionContext.getImageData(0, 0, regionCanvas.width, regionCanvas.height);
  }
  const regions = detectResultRegions(observedFrame);
  if (status.source === 'canvas') {
    lastCanvasResultSequence = lastCanvasSequence;
    lastCanvasResultFound = Boolean(regions);
  }
  // A throttled call above is not a new observation. Only an actual missing
  // receipt scan resets agreement and invalidates queued pre-gap observations.
  const revision = game.reader.scanned(Boolean(regions), now);
  if (!regions) return false;
  if (!game.resultSeen) {
    game.resultSeen = true;
    game.session.endedAt = now;
    game.session.durationMs = Math.max(0, now - game.session.startedAt);
    resetAutoRegions(now, false, true);
    void persistGame(game).catch(reportError);
  }
  if (scoreQueue.length >= 4) return true;
  scoreQueue.push({
    game, at: now, revision, header: crop(regions.header, true), total: crop(regions.total, true),
    paid: crop(regions.paid, true), profit: crop(regions.profit, true), confidence: regions.confidence,
    screenshot: crop(regions.panel).toDataURL('image/jpeg', .85),
  });
  announce({ scoreState: 'reading', message: captureWarning ?? '結果の金額を確認しています' });
  void processQueue();
  return true;
}
function sliceCanvas(input: HTMLCanvasElement, rect: Rect): HTMLCanvasElement {
  const area = pixelRect(rect, input.width, input.height);
  const output = document.createElement('canvas'); output.width = area.width; output.height = area.height;
  output.getContext('2d')!.drawImage(input, area.x, area.y, area.width, area.height, 0, 0, output.width, output.height);
  return output;
}
function resultCanvas(input: HTMLCanvasElement, dark = false): HTMLCanvasElement {
  const output = document.createElement('canvas'); output.width = input.width; output.height = input.height;
  const context = output.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(input, 0, 0);
  const image = context.getImageData(0, 0, output.width, output.height);
  preprocessResultPixels(image.data, output.width, output.height, dark);
  context.putImageData(image, 0, 0);
  return output;
}
async function reviewScore(game: CaptureGame, parsed: ParsedScore, at: number, evidence: string, reason?: string) {
  if (game.scoreSaved) return;
  game.session.scoreReview = {
    ...(parsed.score !== undefined ? { score: parsed.score } : {}), scoreType: 'total',
    confidence: parsed.confidence, observedAt: at, evidence, reason: reason ?? parsed.reason ?? '結果をもう一度確認してください',
  };
  await persistGame(game);
  if (game === activeGame) announce({ scoreState: 'review', scoreReviewSessionId: game.session.id, message: captureWarning ?? '結果は確認待ちに保存しました' });
}
async function acceptScore(game: CaptureGame, parsed: ParsedScore, at: number, evidence: string) {
  if (game.scoreSaved || parsed.score === undefined) return;
  await game.writes;
  const patch = {
    score: parsed.score, scoreType: 'total' as const, scoreConfidence: parsed.confidence,
    scoreObservedAt: at, scoreEvidence: evidence, scoreTotal: parsed.total,
    scoreModeSource: parsed.modeSource,
  };
  const result = await saveCaptureScore(game.session, patch);
  if (!result) return;
  game.scoreSaved = true;
  announce({
    latestScore: result.latestScore,
    ...(game === activeGame ? { scoreState: 'saved' as const, scoreReviewSessionId: undefined } : {}),
    message: captureWarning ?? (game === activeGame ? (result.saved ? 'スコアを自動記録しました' : '保存済みのスコアを確認しました') : status.message),
  });
}
async function recognizeResult(candidate: ResultCandidate) {
  if (!jpWorker || !romanWorker || candidate.game.scoreSaved) return;
  // Gaps invalidate queued score agreement before OCR finishes. Once a game
  // has retained a result/evidence for review, do not spend more worker time
  // on candidates that can no longer confirm it. Keep the first unread one so
  // a quick retry or stop does not discard that game's only review evidence.
  if (!candidate.game.reader.isCurrent(candidate.revision) && candidate.game.lastResult) return;
  const numeric: { total?: NumericScoreText; paid?: NumericScoreText; profit?: NumericScoreText } = {};
  const amountLines: { total?: NumericScoreText; paid?: NumericScoreText; profit?: NumericScoreText } = {};
  const lines: string[] = [];
  let labelText = '', labelConfidence = 0, bodyConfidence = 100;
  let totalLabelText = '', totalLabelConfidence = 0;
  const header = (await jpWorker.recognize(resultCanvas(candidate.header, true))).data;
  await romanWorker.setParameters({ tessedit_char_whitelist: '0123456789,.' });
  try {
    for (const kind of ['total', 'paid', 'profit'] as const) {
      const canvas = candidate[kind], context = canvas.getContext('2d', { willReadFrequently: true })!;
      const numberRect = findAmountRect(context.getImageData(0, 0, canvas.width, canvas.height), kind);
      const [textResult, numberResult] = await Promise.all([
        jpWorker.recognize(resultCanvas(canvas)),
        numberRect ? romanWorker.recognize(resultCanvas(sliceCanvas(canvas, numberRect))) : Promise.resolve(null),
      ]);
      lines.push(textResult.data.text);
      bodyConfidence = Math.min(bodyConfidence, textResult.data.confidence);
      amountLines[kind] = { text: textResult.data.text, confidence: textResult.data.confidence };
      if (numberResult) numeric[kind] = { text: numberResult.data.text, confidence: numberResult.data.confidence };
      if (kind === 'total' || kind === 'profit') {
        let label = textResult.data;
        if (numberRect) {
          const left = numberRect.x + numberRect.width;
          if (left < .8) {
            label = (await jpWorker.recognize(resultCanvas(sliceCanvas(canvas, { x: left, y: 0, width: 1-left, height: 1 })))).data;
          }
        }
        if (kind === 'total') { totalLabelText = label.text; totalLabelConfidence = label.confidence; }
        else { labelText = label.text; labelConfidence = label.confidence; }
      }
    }
  } finally {
    await romanWorker.setParameters({ tessedit_char_whitelist: ROMAN_CHARACTERS });
  }
  let parsed = parseResultScore({
    headerText: header.text, headerConfidence: header.confidence, bodyText: lines.join('\n'), bodyConfidence,
    labelText, labelConfidence, totalLabelText, totalLabelConfidence, amountLines, numeric, structureConfidence: candidate.confidence,
  });
  if (parsed.kind === 'none') parsed = { ...parsed, kind: 'review', reason: '結果の文字を確認してください', fingerprint: `unreadable:${candidate.game.session.id}` };
  candidate.game.lastResult = { parsed, at: candidate.at, evidence: candidate.screenshot };
  const stable = candidate.game.reader.observe(parsed, candidate.at, candidate.revision);
  if (stable?.kind === 'score') await acceptScore(candidate.game, stable, candidate.at, candidate.screenshot);
  else if (stable) await reviewScore(candidate.game, stable, candidate.at, candidate.screenshot);
  else if (candidate.game !== activeGame) await reviewScore(candidate.game, parsed, candidate.at, candidate.screenshot,
    parsed.kind === 'score' ? '2回の一致を確認する前に次のゲームが始まりました' : undefined);
}

async function processQueue() {
  if (processing) return processing;
  processing = (async () => {
    while ((queue.length || scoreQueue.length) && jpWorker && romanWorker) {
      if (scoreQueue.length) {
        const result = scoreQueue.shift()!;
        try { await recognizeResult(result); }
        catch (error) { reportError(error); }
        finally { for (const canvas of [result.header, result.total, result.paid, result.profit]) canvas.width = 1; }
        continue;
      }
      const candidate = queue.shift()!;
      try { await recognize(candidate); }
      catch (error) { reportError(error); }
      if (!candidate.phrase || !candidate.observationReliable) candidate.completionBoundary.settle(null);
      candidate.processed = true;
      await finalizeCandidate(candidate).catch(reportError);
    }
  })().finally(() => { processing = null; });
  return processing;
}

async function initializeWorkers(token: number, signal: AbortSignal) {
  const options = {
    workerPath: chrome.runtime.getURL('vendor/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/core/'),
    langPath: chrome.runtime.getURL('vendor/lang'),
    workerBlobURL: false, gzip: true,
    errorHandler: (error: unknown) => { if (token === generation && !stopped) reportError(error); },
  };
  const workers = await startOcrWorkers(['jpn', 'eng'], options, { signal });
  let transferred = false, disposed = false;
  const dispose = () => {
    if (transferred || disposed) return;
    disposed = true;
    for (const worker of workers) {
      try { void Promise.resolve(worker.terminate()).catch(() => {}); } catch { /* Failed startup cleanup. */ }
    }
  };
  // Keep ownership local until parameter setup completes. Stop can terminate
  // these obtained workers immediately even if setParameters is still pending.
  signal.addEventListener('abort', dispose, { once: true });
  try {
    if (signal.aborted || token !== generation || stopped) { dispose(); return; }
    await Promise.all([
      workers[0].setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '0' }),
      workers[1].setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: ROMAN_CHARACTERS, preserve_interword_spaces: '0' }),
    ]);
    if (signal.aborted || token !== generation || stopped) { dispose(); return; }
    [jpWorker, romanWorker] = workers;
    transferred = true;
    announce({ ocrReady: true, message: captureWarning ?? (calibration ? 'お題を待っています' : 'お題を探しています') });
  } catch (error) { dispose(); throw error; }
  finally { signal.removeEventListener('abort', dispose); }
}
function watchTabFrames(token: number) {
  if (typeof video.requestVideoFrameCallback !== 'function') return;
  const presented: VideoFrameRequestCallback = (_now, metadata) => {
    if (stopped || token !== generation || status.source !== 'tab') return;
    if (metadata.presentedFrames > lastTabPresentation) {
      lastTabPresentation = metadata.presentedFrames;
      lastTabFrameAt = Date.now();
    }
    tabFrameCallback = video.requestVideoFrameCallback(presented);
  };
  tabFrameCallback = video.requestVideoFrameCallback(presented);
}
function stopTabFrameWatch() {
  if (tabFrameCallback !== undefined && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(tabFrameCallback);
  tabFrameCallback = undefined; lastTabFrameAt = 0; lastTabPresentation = lastTabDecoded = -1;
}
function inspectReplayFrame(): ReplayFrame | null {
  const surface = frameSurface(), now = Date.now();
  const at = status.source === 'canvas' ? lastCanvasAt : lastTabFrameAt;
  if (!surface.ready || !surface.width || !surface.height || !at || now - at > REPLAY_MAX_FRAME_AGE_MS || at > now + 1000) return null;
  const scale = Math.min(1, 1280 / Math.max(surface.width, surface.height));
  regionCanvas.width = Math.max(1, Math.round(surface.width * scale));
  regionCanvas.height = Math.max(1, Math.round(surface.height * scale));
  regionContext.drawImage(surface.image, 0, 0, regionCanvas.width, regionCanvas.height);
  const regions = detectResultRegions(regionContext.getImageData(0, 0, regionCanvas.width, regionCanvas.height));
  if (!regions) return null;
  // This is a permission check, never another score observation. In particular,
  // inspecting a frozen receipt cannot supply the second OCR agreement.
  return { source: status.source === 'canvas' ? 'canvas' : 'tab', width: surface.width, height: surface.height, at,
    panel: regions.panel, header: imageSignature(regions.header).bytes, total: imageSignature(regions.total).bytes };
}
function replayStillCurrent(request: ReplayRequest): boolean {
  return !request.cancelled && !stopped && generation === request.token && status.state === 'recording' &&
    status.sessionId === request.captureId && activeGame === request.game && request.game.resultSeen;
}
function sameReplayResult(before: ReplayFrame, after: ReplayFrame): boolean {
  return before.source === after.source && before.width === after.width && before.height === after.height && !panelMoved(before.panel, after.panel) &&
    signatureDistance(before.header, after.header) < .01 && signatureDistance(before.total, after.total) < .01;
}
const replayUnavailable = (reason: string) => ({ ok: true as const, ready: false as const, reason });
async function prepareReplay(message: { sessionId?: unknown }) {
  if (replayRequest) return replayUnavailable('再プレイの準備中です。');
  const game = activeGame, captureId = status.sessionId;
  if (!captureId || message.sessionId !== captureId || stopped || status.state !== 'recording' || !game?.observedPrompt || !game.resultSeen) {
    return replayUnavailable('結果画面を表示してから再試行してください。');
  }
  if (lastReplayGrant?.game === game && Date.now() - lastReplayGrant.at < REPLAY_COOLDOWN_MS) return replayUnavailable('再プレイの準備中です。');
  let initial: ReplayFrame | null;
  try { initial = inspectReplayFrame(); } catch { initial = null; }
  if (!initial) return replayUnavailable('最新の結果画面を確認できませんでした。');
  let cancel!: (reason: string) => void;
  const cancelled = new Promise<ReturnType<typeof replayUnavailable>>(resolve => { cancel = reason => resolve(replayUnavailable(reason)); });
  const request: ReplayRequest = { game, captureId, token: generation, initial, cancelled: false,
    cancel(reason) { request.cancelled = true; cancel(reason); } };
  replayRequest = request;
  const timeout = setTimeout(() => request.cancel('保存の完了を待ってから、もう一度押してください。'), REPLAY_DEADLINE_MS);
  const prepare = (async () => {
    try {
      await processQueue();
      if (!replayStillCurrent(request)) return replayUnavailable('記録または画面が切り替わりました。');
      await Promise.all([...pendingWrites]);
      // The existing queue settles first; retry its latest cumulative snapshot
      // so a previously failed save does not permanently disable a later retry.
      await persistGame(game);
      if (!replayStillCurrent(request)) return replayUnavailable('記録または画面が切り替わりました。');
      if (!game.scoreSaved) {
        const result = game.lastResult;
        if (!result) return replayUnavailable('結果の読み取りが完了していません。');
        // A single observed total is retained for review, never promoted to an
        // automatically confirmed score merely because replay was requested.
        await reviewScore(game, result.parsed, result.at, result.evidence,
          result.parsed.kind === 'score' ? '再プレイ前に2回の一致を確認できなかったため、結果を確認してください' : undefined);
      }
      // Include OCR and final activity/phrase writes which arrived during the
      // first wait or review save. A newer result job must also finish first.
      let saved: Promise<void>;
      do {
        await processQueue();
        await Promise.all([...pendingWrites]);
        saved = game.writes; await saved;
      } while (replayStillCurrent(request) && (processing || pendingWrites.size || saved !== game.writes));
      if (!replayStillCurrent(request) || (!game.scoreSaved && !game.session.scoreReview)) return replayUnavailable('記録または画面が切り替わりました。');
      const latest = inspectReplayFrame();
      if (!latest || !sameReplayResult(initial, latest)) return replayUnavailable('結果画面が変わったため、再プレイを見送りました。');
      return { ok: true as const, ready: true as const };
    } catch {
      return replayUnavailable('結果を保存できませんでした。保存済みの履歴を確認してください。');
    }
  })();
  try {
    const result = await Promise.race([prepare, cancelled]);
    if (result.ready) {
      if (!replayStillCurrent(request)) return replayUnavailable('記録または画面が切り替わりました。');
      let latest: ReplayFrame | null;
      try { latest = inspectReplayFrame(); } catch { latest = null; }
      if (!latest || !sameReplayResult(initial, latest)) return replayUnavailable('結果画面が変わったため、再プレイを見送りました。');
      lastReplayGrant = { game, at: Date.now() };
    }
    return result;
  } finally {
    clearTimeout(timeout); request.cancelled = true;
    if (replayRequest === request) replayRequest = null;
  }
}
function decodeCanvasBitmap(dataUrl: string, signal: AbortSignal): Promise<ImageBitmap> {
  // Decode bytes directly, without HTMLImageElement's rendering lifecycle.
  // The offscreen document has no visible rendering opportunity; its frame ACK
  // must not depend on an image being prepared for a future document paint.
  // This stays in memory and does not fetch a data URL or loosen extension CSP.
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const abort = () => fail(new Error('ゲーム画面の読み込みを中止しました。'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => fail(new Error('ゲーム画面の読み込みがタイムアウトしました。寿司打を再読み込みしてください。')), CANVAS_DECODE_TIMEOUT_MS);
    try {
      const binary = atob(dataUrl.slice(CANVAS_JPEG_PREFIX.length));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      void createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then(bitmap => {
        // Native decoding itself is not cancellable. Discard and release a
        // late bitmap rather than letting it replace a newer recording frame.
        if (settled) { bitmap.close(); return; }
        settled = true; cleanup(); resolve(bitmap);
      }, fail);
    } catch (error) { fail(error); }
  });
}
async function receiveCanvasFrame(message: { sessionId?: unknown; frame?: Partial<CanvasFrame> }) {
  if (stopped || status.source !== 'canvas' || status.state !== 'recording' || message.sessionId !== status.sessionId) {
    return { ok: true, dropped: true };
  }
  const frame = message.frame;
  if (!frame || typeof frame.dataUrl !== 'string' || frame.dataUrl.length <= CANVAS_JPEG_PREFIX.length || frame.dataUrl.length > MAX_CANVAS_DATA_LENGTH ||
      !frame.dataUrl.startsWith(CANVAS_JPEG_PREFIX) ||
      !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
      frame.width! < 1 || frame.width! > 1920 || frame.height! < 1 || frame.height! > 1440 ||
      !Number.isSafeInteger(frame.sequence) || frame.sequence! < 0 || !Number.isFinite(frame.at)) {
    return { ok: false, error: 'ゲーム画面を読み取れませんでした。' };
  }
  const at = frame.at!, sequence = frame.sequence!;
  if (pendingCanvasDecode || sequence <= lastCanvasSequence || at <= lastCanvasAt ||
      at < (status.startedAt ?? 0) || at > Date.now() + 1000) return { ok: true, dropped: true };
  const token = generation, captureId = status.sessionId, decode = new AbortController();
  pendingCanvasDecode = decode;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await decodeCanvasBitmap(frame.dataUrl, decode.signal);
    if (stopped || token !== generation || captureId !== status.sessionId || status.source !== 'canvas' ||
        status.state !== 'recording' || pendingCanvasDecode !== decode || sequence <= lastCanvasSequence || at <= lastCanvasAt) {
      return { ok: true, dropped: true };
    }
    if (bitmap.width !== frame.width || bitmap.height !== frame.height) {
      return { ok: false, error: 'ゲーム画面の大きさを確認できませんでした。' };
    }
    if (lastCanvasAt && at - lastCanvasAt > MAX_CANVAS_GAP_MS) {
      // Hidden, stalled or lost frames cannot establish a phrase boundary or
      // count as an uninterrupted second observation of a result receipt.
      resetAutoRegions(at);
      activeGame?.reader.scanned(false, at);
      lastResultScan = 0;
    }
    if (externalCanvas.width !== frame.width || externalCanvas.height !== frame.height) {
      externalCanvas.width = frame.width!; externalCanvas.height = frame.height!;
    }
    externalContext.drawImage(bitmap, 0, 0);
    lastCanvasAt = at; lastCanvasSequence = sequence;
    status = { ...status, lastFrameAt: at };
    sampleFrame(at);
    return { ok: true };
  } catch (error) {
    if (stopped || token !== generation || captureId !== status.sessionId) return { ok: true, dropped: true };
    return { ok: false, error: error instanceof Error ? error.message : 'ゲーム画面を読み取れませんでした。' };
  } finally {
    bitmap?.close();
    if (pendingCanvasDecode === decode) pendingCanvasDecode = null;
  }
}
async function start(message: { source?: 'canvas' | 'tab'; streamId?: string; tabId: number; sessionId: string; startedAt: number; settings: Settings }) {
  if (stream || ['starting', 'recording', 'stopping'].includes(status.state)) return { ok: false, error: '記録はすでに開始しています。' };
  const source = message.source ?? 'tab';
  if (!['canvas', 'tab'].includes(source) || (source === 'tab' && !message.streamId)) return { ok: false, error: '画面の取得方法を確認できませんでした。' };
  const token = ++generation;
  replayRequest?.cancel('記録が切り替わりました。'); lastReplayGrant = null; stopTabFrameWatch();
  stopped = false; stopTask = null;
  settings = message.settings;
  // Stored rectangles belong to an old viewport. Automatic detection is the
  // default for every session; a manual override is applied only on request.
  calibration = undefined; manualRegions = false; detectedRegions = null; lastRegionScan = 0;
  keyBuffer = []; seenKeyEvents = new Set(); focusGaps = []; queue = []; scoreQueue = []; currentCandidate = undefined;
  games = []; activeGame = null; session = null; lastResultScan = 0;
  promptSignatures.reset(); sequence = 0;
  lastCanvasAt = 0; lastCanvasSequence = lastCanvasResultSequence = -1; lastCanvasResultFound = false;
  pendingCanvasDecode?.abort(); pendingCanvasDecode = null; externalCanvas.width = externalCanvas.height = 1;
  captureWarning = undefined; lastFrameWidth = lastFrameHeight = 0;
  status = { state: 'starting', source, tabId: message.tabId, sessionId: message.sessionId, startedAt: message.startedAt, phraseCount: 0, ocrReady: false, regionState: 'searching', scoreState: 'watching' };
  try {
    if (source === 'tab') {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, minFrameRate: 15, maxFrameRate: 30 } } as MediaTrackConstraints,
      });
      if (stopped || token !== generation) {
        acquired.getTracks().forEach(track => track.stop());
        return { ok: false, error: '記録の開始を中止しました。' };
      }
      stream = acquired; video.srcObject = stream;
      await video.play();
      if (stopped || token !== generation) return { ok: false, error: '記録の開始を中止しました。' };
      watchTabFrames(token);
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (!stopped) {
          void stop().then(() => announce({ state: 'idle', message: captureWarning ?? '画面共有が終了しました。' }));
        }
      }, { once: true }));
      const firstGame = makeGame(message.startedAt, message.sessionId);
      await firstGame.writes;
      if (stopped || token !== generation) return { ok: false, error: '記録の開始を中止しました。' };
    }
    announce({ state: 'recording', message: '文字認識を準備しています' });
    // External frames are sampled exactly once, on arrival with their capture
    // timestamp. An interval would turn one stale image into repeated evidence.
    if (source === 'tab') sampleTimer = setInterval(sampleFrame, SAMPLE_MS);
    activityTimer = setInterval(checkpointActivity, 5000);
    heartbeat = setInterval(() => {
      if (status.startedAt && Date.now() - status.startedAt > 60 * 60 * 1000) { void stop(); return; }
      if (status.state === 'recording') announce();
    }, 15000);
    const controller = new AbortController();
    initializationController = controller;
    initializing = initializeWorkers(token, controller.signal).catch(error => {
      if (token === generation && !stopped) {
        announce({ ocrReady: false, message: '文字認識を起動できませんでした。拡張を再読み込みしてください。' });
        console.error('Local OCR initialization failed', error instanceof Error ? error.message : 'OCR error');
      }
    }).finally(() => { if (initializationController === controller) initializationController = null; });
    return { ok: true, status };
  } catch (error) {
    if (stopped || token !== generation) return { ok: false, error: '記録の開始を中止しました。' };
    stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; stopTabFrameWatch();
    const message = error instanceof Error ? error.message : '画面を取得できませんでした。';
    stopped = true;
    announce({ state: 'error', message });
    return { ok: false, error: message };
  }
}
function stop(): Promise<unknown> {
  if (stopTask) return stopTask;
  stopTask = finishStop();
  return stopTask;
}
async function finishStop() {
  replayRequest?.cancel('記録を終了しました。');
  if (stopped) return { ok: true, status };
  // Tab capture can sample its still-live video once before stopping. A canvas
  // frame was already observed on arrival and must not count as fresh evidence.
  // OCR then drains only already-cropped images, without continuing screen access.
  if (status.source !== 'canvas') collectResultFrame(Date.now(), true);
  stopped = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (heartbeat) clearInterval(heartbeat);
  if (activityTimer) clearInterval(activityTimer);
  sampleTimer = heartbeat = activityTimer = undefined;
  const endedAt = Date.now();
  breakActivity(activeGame, endedAt);
  for (const game of games) recordObservedActivity(game);
  endCurrent(endedAt);
  announce({ state: 'stopping', message: '最後のお題を保存しています' });
  // Stop the media tracks immediately; only already-cropped text awaits OCR.
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null; stopTabFrameWatch();
  pendingCanvasDecode?.abort(); pendingCanvasDecode = null; lastCanvasAt = 0; externalCanvas.width = externalCanvas.height = 1;
  // A Tesseract startup error can leave its underlying createWorker promise
  // pending forever. Abort our startup ownership and do not await that promise;
  // background closes this document after stop returns, releasing raw workers
  // that Tesseract has not exposed through its public API.
  initializationController?.abort(); initializationController = null;
  initializing = null;
  if (!jpWorker || !romanWorker) {
    for (const candidate of queue) candidate.completionBoundary.settle(null);
    currentCandidate?.completionBoundary.settle(null);
  }
  await processQueue();
  if (currentCandidate) await finalizeCandidate(currentCandidate).catch(reportError);
  await Promise.all([...pendingWrites]);
  for (const game of games) {
    if (!game.scoreSaved && game.lastResult) {
      const last = game.lastResult;
      await reviewScore(game, last.parsed, last.at, last.evidence,
        last.parsed.kind === 'score' ? '2回の一致を確認する前に記録が終了しました' : undefined);
    }
    if (!game.session.endedAt) game.session.endedAt = endedAt;
    game.session.durationMs = Math.max(0, game.session.endedAt - game.session.startedAt);
    await persistGame(game);
  }
  generation++;
  await Promise.all([jpWorker?.terminate(), romanWorker?.terminate()]);
  jpWorker = romanWorker = null; initializing = null;
  keyBuffer = []; seenKeyEvents.clear(); focusGaps = []; queue = []; scoreQueue = []; currentCandidate = undefined;
  calibration = undefined; detectedRegions = null; manualRegions = false;
  announce({ state: 'idle', ocrReady: false, regionState: undefined, regionConfidence: undefined, region: undefined, message: captureWarning });
  return { ok: true, status, sessionId: session?.id };
}
function snapshot() {
  const surface = frameSurface();
  if (stopped || status.state !== 'recording' || !surface.ready || !surface.width) return { ok: false, error: '画面の準備中です。少し待ってから再試行してください。' };
  const canvas = document.createElement('canvas'); canvas.width = surface.width; canvas.height = surface.height;
  canvas.getContext('2d')!.drawImage(surface.image, 0, 0);
  return { ok: true, frame: { dataUrl: canvas.toDataURL('image/jpeg', .9), width: canvas.width, height: canvas.height, at: status.source === 'canvas' ? lastCanvasAt : Date.now() } };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen' || typeof message.type !== 'string') return;
  let task: Promise<unknown> | undefined;
  switch (message.type) {
    case 'UCHI_OFF_START': task = start(message); break;
    case 'UCHI_OFF_CANVAS_FRAME': task = receiveCanvasFrame(message); break;
    case 'UCHI_OFF_STOP': task = stop(); break;
    case 'UCHI_OFF_REPLAY': task = prepareReplay(message); break;
    case 'UCHI_OFF_STATUS': sendResponse({ ok: true, status }); return;
    case 'UCHI_OFF_FRAME': sendResponse(snapshot()); return;
    case 'UCHI_OFF_KEYS':
      if (message.sessionId === status.sessionId && Array.isArray(message.keys) && (status.state === 'recording' || status.state === 'stopping')) {
        const fresh: KeyStroke[] = [];
        for (const key of message.keys as KeyStroke[]) {
          if (!key || typeof key.key !== 'string' || key.key.length !== 1 || !Number.isFinite(key.at)) continue;
          const id = physicalKeyId(key);
          if (seenKeyEvents.has(id)) continue;
          seenKeyEvents.add(id); fresh.push(key);
        }
        keyBuffer.push(...fresh);
        for (const game of games) recordObservedActivity(game, fresh);
        if (keyBuffer.length > MAX_KEY_BUFFER) {
          keyBuffer.splice(0, keyBuffer.length - MAX_KEY_BUFFER);
          for (const candidate of queue) { candidate.reliableBoundary = false; candidate.completionBoundary.settle(null); }
          if (currentCandidate) { currentCandidate.reliableBoundary = false; currentCandidate.completionBoundary.settle(null); }
        }
      }
      sendResponse({ ok: true }); return;
    case 'UCHI_OFF_VIEW_CHANGE':
      if (message.sessionId === status.sessionId && status.state === 'recording') resetAutoRegions(Date.now());
      sendResponse({ ok: true }); return;
    case 'UCHI_OFF_AUTO_REGION':
      if (status.state === 'recording') resetAutoRegions(Date.now());
      sendResponse({ ok: true, status }); return;
    case 'UCHI_OFF_GAP':
      if (message.sessionId === status.sessionId && ['recording', 'stopping'].includes(status.state) && Number.isFinite(message.at)) {
        focusGaps.push(message.at);
        breakActivity(activeGame, message.at);
        if (currentCandidate && message.at >= currentCandidate.at && (!currentCandidate.endedAt || message.at < currentCandidate.endedAt)) {
          currentCandidate.completionBoundary.settle(null);
        }
      }
      sendResponse({ ok: true }); return;
    case 'UCHI_OFF_CALIBRATE':
      if (!isCalibration(message.calibration)) { sendResponse({ ok: false }); return; }
      resetAutoRegions(Date.now(), false);
      calibration = message.calibration; manualRegions = true;
      { const frame = frameSurface(); lastFrameWidth = frame.width; lastFrameHeight = frame.height; }
      promptSignatures.reset();
      announce({ regionState: 'manual', regionConfidence: undefined, region: undefined, message: captureWarning ?? (status.ocrReady ? '手動の範囲で読み取っています' : '文字認識を準備しています') });
      sendResponse({ ok: true }); return;
    default: return;
  }
  void task?.then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '記録処理でエラーが発生しました。' }));
  return true;
});
