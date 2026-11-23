import { PSM, type Worker as OcrWorker } from 'tesseract.js';
import { saveAttempt, savePhrase, saveSession } from '../core/db';
import type { Calibration, CaptureStatus, KeyStroke, Phrase, Rect, Session, Settings } from '../core/types';
import { EMPTY_CAPTURE } from '../core/types';
import { isCalibration, MAX_CANDIDATES, MAX_KEY_BUFFER, normalizeJapanese, normalizeOcrRoman, pixelRect, preprocessOcrPixels, SAMPLE_MS, unionRects, validJapanese, validRoman } from './helpers';
import { detectPromptRegions, type AutoRegions } from './auto-region';
import { resolveOcrReading } from './ocr-reading';
import { detectResultRegions, findAmountRect, preprocessResultPixels } from './auto-result';
import { parseResultScore, type NumericScoreText, type ParsedScore } from './score-parser';
import { createCompletionBoundary, replayCapturedPhrase, type CompletionBoundary } from './key-boundary';
import { saveCaptureScore } from './score-persistence';
import { closeObservedBoundary, PromptSignatureTracker, ResultFrameSequence } from './frame-lifecycle';
import { startOcrWorkers } from './ocr-worker';

interface CaptureGame {
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
let calibration: Calibration | undefined;
let settings: Settings | null = null;
let jpWorker: OcrWorker | null = null;
let romanWorker: OcrWorker | null = null;
let initializing: Promise<void> | null = null;
let initializationController: AbortController | null = null;
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let keyBuffer: KeyStroke[] = [];
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
let lastVideoWidth = 0;
let lastVideoHeight = 0;
const detectCanvas = document.createElement('canvas');
detectCanvas.width = 192; detectCanvas.height = 32;
const detectContext = detectCanvas.getContext('2d', { willReadFrequently: true })!;
const regionCanvas = document.createElement('canvas');
const regionContext = regionCanvas.getContext('2d', { willReadFrequently: true })!;
const REGION_SCAN_MS = 240;
const RESULT_SCAN_MS = 1200;
const ROMAN_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,-'/():;[]";

function announce(patch: Partial<CaptureStatus> = {}) {
  status = { ...status, ...patch };
  lastPublish = Date.now();
  void chrome.runtime.sendMessage({ type: 'UCHI_OFF_STATE', status }).catch(() => {});
}
function makeGame(at: number, id: string = crypto.randomUUID()): CaptureGame {
  const data: Session = {
    id, captureId: status.sessionId, startedAt: at, source: 'capture', scoreType: settings!.scoreType,
    course: 10000, mode: 'accuracy', phraseCount: 0, correctKeys: 0, mistakes: 0, durationMs: 0,
  };
  const game: CaptureGame = { session: data, writes: saveSession(data), observedPrompt: false, resultSeen: false, scoreSaved: false, reader: new ResultFrameSequence(data.scoreType) };
  // Every queued OCR job keeps its own game, so a quick retry cannot attach an
  // old phrase or result to the next game in the same continuous recording.
  games.push(game); activeGame = game; session = data;
  void game.writes.catch(reportError);
  announce({ activeSessionId: id, scoreState: 'watching', scoreReviewSessionId: undefined });
  return game;
}
function persistGame(game: CaptureGame): Promise<void> {
  game.writes = game.writes.catch(() => {}).then(() => saveSession(game.session));
  return game.writes;
}
function observePrompt(at: number) {
  if (!activeGame || activeGame.resultSeen) {
    const previous = activeGame;
    makeGame(at);
    if (previous && !previous.scoreSaved && previous.lastResult) {
      const last = previous.lastResult;
      void reviewScore(previous, last.parsed, last.at, last.evidence,
        last.parsed.kind === 'score' ? '2回の一致を確認する前に次のゲームが始まりました' : undefined).catch(reportError);
    }
  }
  activeGame!.observedPrompt = true;
}
function crop(rect: Rect, upscale = false): HTMLCanvasElement {
  const area = pixelRect(rect, video.videoWidth, video.videoHeight);
  const scale = upscale ? Math.min(3, Math.max(2, 56 / area.height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.width * scale));
  canvas.height = Math.max(1, Math.round(area.height * scale));
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(video, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
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
  const area = pixelRect(rect, video.videoWidth, video.videoHeight);
  detectContext.drawImage(video, area.x, area.y, area.width, area.height, 0, 0, detectCanvas.width, detectCanvas.height);
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
  if (currentCandidate.processed) {
    const write = finalizeCandidate(currentCandidate).catch(reportError);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  }
}
function resetAutoRegions(at: number, publish = true, confirmedResult = false) {
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
  const tolerance = Math.max(3, previous.height * video.videoHeight * .025);
  return Math.abs(previous.x - next.x) * video.videoWidth > tolerance ||
    Math.abs(previous.y - next.y) * video.videoHeight > tolerance ||
    Math.abs(previous.width - next.width) * video.videoWidth > tolerance ||
    Math.abs(previous.height - next.height) * video.videoHeight > tolerance;
}
function scanRegions(now: number) {
  if (manualRegions || now - lastRegionScan < REGION_SCAN_MS) return;
  lastRegionScan = now;
  // OCR still uses the original-resolution frame. Only the inexpensive frame
  // locator is reduced, keeping large displays from blocking the sample loop.
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  if (regionCanvas.width !== width || regionCanvas.height !== height) {
    regionCanvas.width = width; regionCanvas.height = height;
  }
  regionContext.drawImage(video, 0, 0, width, height);
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
    viewport: { width: video.videoWidth, height: video.videoHeight }, updatedAt: now,
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
  return {
    game: activeGame!, completionBoundary: createCompletionBoundary(),
    precedingBoundary: reliableBoundary && currentCandidate?.game === activeGame ? currentCandidate.completionBoundary : undefined,
    id: ++sequence, at, japanese: crop(c.japanese, true), reading: c.reading ? crop(c.reading, true) : undefined,
    roman: crop(c.roman, true), screenshot: evidence.toDataURL('image/jpeg', .84), signature,
    processed: false, finalized: false, reliableBoundary, observationReliable: false,
  };
}
function sampleFrame() {
  if (stopped || status.state !== 'recording' || video.readyState < 2 || !video.videoWidth) return;
  const now = Date.now();
  if (video.videoWidth !== lastVideoWidth || video.videoHeight !== lastVideoHeight) {
    if (lastVideoWidth && lastVideoHeight) resetAutoRegions(now);
    lastVideoWidth = video.videoWidth; lastVideoHeight = video.videoHeight;
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
  if (!game?.observedPrompt || game.scoreSaved || !status.ocrReady || video.readyState < 2 || !video.videoWidth) return false;
  if (!force && now - lastResultScan < RESULT_SCAN_MS) return false;
  lastResultScan = now;
  if (!observedFrame) {
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    regionCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    regionCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    regionContext.drawImage(video, 0, 0, regionCanvas.width, regionCanvas.height);
    observedFrame = regionContext.getImageData(0, 0, regionCanvas.width, regionCanvas.height);
  }
  const regions = detectResultRegions(observedFrame);
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
    ...(parsed.score !== undefined ? { score: parsed.score } : {}), scoreType: game.session.scoreType,
    confidence: parsed.confidence, observedAt: at, evidence, reason: reason ?? parsed.reason ?? '結果をもう一度確認してください',
  };
  await persistGame(game);
  if (game === activeGame) announce({ scoreState: 'review', scoreReviewSessionId: game.session.id, message: captureWarning ?? '結果は確認待ちに保存しました' });
}
async function acceptScore(game: CaptureGame, parsed: ParsedScore, at: number, evidence: string) {
  if (game.scoreSaved || parsed.score === undefined) return;
  await game.writes;
  const patch = {
    score: parsed.score, scoreType: game.session.scoreType, scoreConfidence: parsed.confidence,
    scoreObservedAt: at, scoreEvidence: evidence, scoreTotal: parsed.total, scoreProfit: parsed.profit,
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
  const numeric: { total?: NumericScoreText; paid?: NumericScoreText; profit?: NumericScoreText } = {};
  const lines: string[] = [];
  let labelText = '', labelConfidence = 0, bodyConfidence = 100;
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
      if (numberResult) numeric[kind] = { text: numberResult.data.text, confidence: numberResult.data.confidence };
      if (kind === 'profit') {
        labelText = textResult.data.text; labelConfidence = textResult.data.confidence;
        if (numberRect) {
          const left = numberRect.x + numberRect.width;
          if (left < .8) {
            const label = (await jpWorker.recognize(resultCanvas(sliceCanvas(canvas, { x: left, y: 0, width: 1-left, height: 1 })))).data;
            labelText = label.text; labelConfidence = label.confidence;
          }
        }
      }
    }
  } finally {
    await romanWorker.setParameters({ tessedit_char_whitelist: ROMAN_CHARACTERS });
  }
  let parsed = parseResultScore({
    headerText: header.text, headerConfidence: header.confidence, bodyText: lines.join('\n'), bodyConfidence,
    labelText, labelConfidence, numeric, structureConfidence: candidate.confidence, scoreType: candidate.game.session.scoreType,
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
async function start(message: { streamId: string; tabId: number; sessionId: string; startedAt: number; settings: Settings }) {
  if (stream) return { ok: false, error: '記録はすでに開始しています。' };
  const token = ++generation;
  stopped = false; stopTask = null;
  settings = message.settings;
  // Stored rectangles belong to an old viewport. Automatic detection is the
  // default for every session; a manual override is applied only on request.
  calibration = undefined; manualRegions = false; detectedRegions = null; lastRegionScan = 0;
  keyBuffer = []; focusGaps = []; queue = []; scoreQueue = []; currentCandidate = undefined;
  games = []; activeGame = null; session = null; lastResultScan = 0;
  promptSignatures.reset(); sequence = 0;
  captureWarning = undefined; lastVideoWidth = lastVideoHeight = 0;
  status = { state: 'starting', tabId: message.tabId, sessionId: message.sessionId, startedAt: message.startedAt, phraseCount: 0, ocrReady: false, regionState: 'searching', scoreState: 'watching' };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, minFrameRate: 15, maxFrameRate: 30 } } as MediaTrackConstraints,
    });
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (!stopped) {
        void stop().then(() => announce({ state: 'idle', message: captureWarning ?? '画面共有が終了しました。' }));
      }
    }, { once: true }));
    const firstGame = makeGame(message.startedAt, message.sessionId);
    await firstGame.writes;
    announce({ state: 'recording', message: '文字認識を準備しています' });
    sampleTimer = setInterval(sampleFrame, SAMPLE_MS);
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
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    return { ok: false, error: error instanceof Error ? error.message : '画面を取得できませんでした。' };
  }
}
function stop(): Promise<unknown> {
  if (stopTask) return stopTask;
  stopTask = finishStop();
  return stopTask;
}
async function finishStop() {
  if (stopped) return { ok: true, status };
  // Capture the last visible receipt before stopping its video track. OCR then
  // drains only these already-cropped images, with no continuing screen access.
  collectResultFrame(Date.now(), true);
  stopped = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (heartbeat) clearInterval(heartbeat);
  const endedAt = Date.now();
  endCurrent(endedAt);
  announce({ state: 'stopping', message: '最後のお題を保存しています' });
  // Stop the media tracks immediately; only already-cropped text awaits OCR.
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null;
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
  keyBuffer = []; focusGaps = []; queue = []; scoreQueue = []; currentCandidate = undefined;
  calibration = undefined; detectedRegions = null; manualRegions = false;
  announce({ state: 'idle', ocrReady: false, regionState: undefined, regionConfidence: undefined, region: undefined, message: captureWarning });
  return { ok: true, status, sessionId: session?.id };
}
function snapshot() {
  if (!stream || !video.videoWidth || video.readyState < 2) return { ok: false, error: '画面の準備中です。少し待ってから再試行してください。' };
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0);
  return { ok: true, frame: { dataUrl: canvas.toDataURL('image/jpeg', .9), width: canvas.width, height: canvas.height, at: Date.now() } };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen' || typeof message.type !== 'string') return;
  let task: Promise<unknown> | undefined;
  switch (message.type) {
    case 'UCHI_OFF_START': task = start(message); break;
    case 'UCHI_OFF_STOP': task = stop(); break;
    case 'UCHI_OFF_STATUS': sendResponse({ ok: true, status }); return;
    case 'UCHI_OFF_FRAME': sendResponse(snapshot()); return;
    case 'UCHI_OFF_KEYS':
      if (message.sessionId === status.sessionId && Array.isArray(message.keys) && (status.state === 'recording' || status.state === 'stopping')) {
        keyBuffer.push(...message.keys);
        if (keyBuffer.length > MAX_KEY_BUFFER) {
          keyBuffer.splice(0, keyBuffer.length - MAX_KEY_BUFFER);
          for (const candidate of queue) { candidate.reliableBoundary = false; candidate.completionBoundary.settle(null); }
          if (currentCandidate) { currentCandidate.reliableBoundary = false; currentCandidate.completionBoundary.settle(null); }
        }
      }
      sendResponse({ ok: true }); return;
    case 'UCHI_OFF_VIEW_CHANGE':
      if (status.state === 'recording') resetAutoRegions(Date.now());
      sendResponse({ ok: true }); return;
    case 'UCHI_OFF_AUTO_REGION':
      if (status.state === 'recording') resetAutoRegions(Date.now());
      sendResponse({ ok: true, status }); return;
    case 'UCHI_OFF_GAP':
      if (Number.isFinite(message.at)) {
        focusGaps.push(message.at);
        if (currentCandidate && message.at >= currentCandidate.at && (!currentCandidate.endedAt || message.at < currentCandidate.endedAt)) {
          currentCandidate.completionBoundary.settle(null);
        }
      }
      sendResponse({ ok: true }); return;
    case 'UCHI_OFF_CALIBRATE':
      if (!isCalibration(message.calibration)) { sendResponse({ ok: false }); return; }
      resetAutoRegions(Date.now(), false);
      calibration = message.calibration; manualRegions = true;
      lastVideoWidth = video.videoWidth; lastVideoHeight = video.videoHeight;
      promptSignatures.reset();
      announce({ regionState: 'manual', regionConfidence: undefined, region: undefined, message: captureWarning ?? (status.ocrReady ? '手動の範囲で読み取っています' : '文字認識を準備しています') });
      sendResponse({ ok: true }); return;
    default: return;
  }
  void task?.then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '記録処理でエラーが発生しました。' }));
  return true;
});
