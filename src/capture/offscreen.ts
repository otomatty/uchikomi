import { createWorker, PSM, type Worker as OcrWorker } from 'tesseract.js';
import { saveAttempt, savePhrase, saveSession } from '../core/db';
import { buildAttempt } from '../core/analytics';
import type { Calibration, CaptureStatus, KeyStroke, Phrase, Rect, Session, Settings } from '../core/types';
import { EMPTY_CAPTURE } from '../core/types';
import { isCalibration, MAX_CANDIDATES, MAX_KEY_BUFFER, normalizeJapanese, normalizeOcrRoman, pixelRect, preprocessOcrPixels, SAMPLE_MS, signatureDistance, unionRects, validJapanese, validRoman } from './helpers';
import { detectPromptRegions, type AutoRegions } from './auto-region';
import { resolveOcrReading } from './ocr-reading';

interface Candidate {
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
let sampleTimer: ReturnType<typeof setInterval> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let keyBuffer: KeyStroke[] = [];
let focusGaps: number[] = [];
let queue: Candidate[] = [];
let currentCandidate: Candidate | undefined;
let processing: Promise<void> | null = null;
let lastSignature: Uint8Array | null = null;
let pendingSignature: Uint8Array | null = null;
let pendingAt = 0;
let pendingCount = 0;
let sequence = 0;
let generation = 0;
let stopped = false;
let stopTask: Promise<unknown> | null = null;
const pendingWrites = new Set<Promise<void>>();
let session: Session | null = null;
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

function announce(patch: Partial<CaptureStatus> = {}) {
  status = { ...status, ...patch };
  lastPublish = Date.now();
  void chrome.runtime.sendMessage({ type: 'UCHI_OFF_STATE', status }).catch(() => {});
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
  if (!candidate.phrase || !session) return;
  // A final key may still be in the content script's 90 ms batch.
  const settle = candidate.endedAt + 200 - Date.now();
  if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle));
  const strokes = keyBuffer.filter(key => key.at >= candidate.at && key.at < candidate.endedAt!);
  if (!strokes.length) return;
  const reliable = candidate.observationReliable && candidate.phrase.verified && candidate.reliableBoundary && !focusGaps.some(at => at > candidate.at && at < candidate.endedAt!);
  const attempt = buildAttempt({ phrase: candidate.phrase, strokes, startedAt: candidate.at, endedAt: candidate.endedAt, sessionId: session.id, source: 'capture', complete: true, reliable });
  await saveAttempt(attempt);
  if (attempt.reliable) {
    session.correctKeys += attempt.correctKeys;
    session.mistakes += attempt.mistakes;
  }
  // Image buffers are released as soon as OCR and key alignment finish.
  candidate.japanese.width = 1; candidate.roman.width = 1;
  if (candidate.reading) candidate.reading.width = 1;
}
function endCurrent(at: number) {
  if (!currentCandidate || currentCandidate.endedAt) return;
  currentCandidate.endedAt = at;
  if (currentCandidate.processed) {
    const write = finalizeCandidate(currentCandidate).catch(reportError);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  }
}
function resetAutoRegions(at: number, publish = true) {
  // Losing the visible frame leaves the end of this attempt uncertain. Keep the
  // observed phrase, but never include its partial timing in weakness rankings.
  if (currentCandidate && !currentCandidate.endedAt) currentCandidate.reliableBoundary = false;
  endCurrent(at);
  calibration = undefined;
  detectedRegions = null;
  manualRegions = false;
  lastRegionScan = 0;
  lastSignature = pendingSignature = null;
  pendingCount = 0;
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
    if (calibration || status.regionState !== 'searching') resetAutoRegions(now);
    return;
  }
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
  scanRegions(now);
  if (!status.ocrReady || !calibration) return;
  const { bytes, ink } = imageSignature(calibration.japanese);
  if (ink < .006 || ink > .85) {
    if (currentCandidate && !currentCandidate.endedAt && now - currentCandidate.at > 200) endCurrent(now);
    lastSignature = null; pendingSignature = null; pendingCount = 0;
    return;
  }
  if (lastSignature && signatureDistance(bytes, lastSignature) < .018) { pendingSignature = null; pendingCount = 0; return; }
  if (!pendingSignature || signatureDistance(bytes, pendingSignature) > .018) {
    pendingSignature = bytes; pendingAt = now; pendingCount = 1; return;
  }
  pendingCount++;
  if (pendingCount < 2) return;
  // The frame epoch is retained here. OCR completion never becomes a boundary.
  // The first phrase after start/reacquisition may already be partly typed.
  // Only an uninterrupted, observed transition establishes a reliable start.
  const reliableBoundary = lastSignature !== null;
  endCurrent(pendingAt);
  const candidate = candidateFromFrame(pendingAt, bytes, reliableBoundary);
  currentCandidate = candidate;
  lastSignature = bytes; pendingSignature = null; pendingCount = 0;
  if (queue.length >= MAX_CANDIDATES) {
    queue.shift(); candidate.reliableBoundary = false;
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
  if (session) { session.phraseCount++; await saveSession(session); }
  announce({ phraseCount: (status.phraseCount ?? 0) + 1, latestPhrase: phrase.text, lastFrameAt: candidate.at, message: captureWarning });
}
async function processQueue() {
  if (processing) return processing;
  processing = (async () => {
    while (queue.length && jpWorker && romanWorker) {
      const candidate = queue.shift()!;
      try { await recognize(candidate); }
      catch (error) { reportError(error); }
      candidate.processed = true;
      await finalizeCandidate(candidate).catch(reportError);
    }
  })().finally(() => { processing = null; });
  return processing;
}

async function initializeWorkers(token: number) {
  const options = {
    workerPath: chrome.runtime.getURL('vendor/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/core/'),
    langPath: chrome.runtime.getURL('vendor/lang'),
    workerBlobURL: false, gzip: true,
    errorHandler: (error: unknown) => { if (token === generation && !stopped) reportError(error); },
  };
  const results = await Promise.allSettled([createWorker('jpn', 1, options), createWorker('eng', 1, options)]);
  if (results.some(result => result.status === 'rejected')) {
    await Promise.all(results.filter((result): result is PromiseFulfilledResult<OcrWorker> => result.status === 'fulfilled').map(result => result.value.terminate()));
    throw new Error('Packaged OCR assets could not be loaded');
  }
  const workers = results.map(result => (result as PromiseFulfilledResult<OcrWorker>).value);
  if (token !== generation || stopped) { await Promise.all(workers.map(worker => worker.terminate())); return; }
  [jpWorker, romanWorker] = workers;
  await Promise.all([
    jpWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '0' }),
    romanWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,-'/():;[]", preserve_interword_spaces: '0' }),
  ]);
  if (token !== generation || stopped) return;
  announce({ ocrReady: true, message: captureWarning ?? (calibration ? 'お題を待っています' : 'お題を探しています') });
}
async function start(message: { streamId: string; tabId: number; sessionId: string; startedAt: number; settings: Settings }) {
  if (stream) return { ok: false, error: '記録はすでに開始しています。' };
  const token = ++generation;
  stopped = false; stopTask = null;
  settings = message.settings;
  // Stored rectangles belong to an old viewport. Automatic detection is the
  // default for every session; a manual override is applied only on request.
  calibration = undefined; manualRegions = false; detectedRegions = null; lastRegionScan = 0;
  keyBuffer = []; focusGaps = []; queue = []; currentCandidate = undefined;
  lastSignature = pendingSignature = null; pendingCount = 0; sequence = 0;
  captureWarning = undefined; lastVideoWidth = lastVideoHeight = 0;
  status = { state: 'starting', tabId: message.tabId, sessionId: message.sessionId, startedAt: message.startedAt, phraseCount: 0, ocrReady: false, regionState: 'searching' };
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
    session = { id: message.sessionId, startedAt: message.startedAt, source: 'capture', scoreType: settings.scoreType, course: 10000, mode: 'accuracy', phraseCount: 0, correctKeys: 0, mistakes: 0, durationMs: 0 };
    await saveSession(session);
    announce({ state: 'recording', message: '文字認識を準備しています' });
    sampleTimer = setInterval(sampleFrame, SAMPLE_MS);
    heartbeat = setInterval(() => {
      if (session && Date.now() - session.startedAt > 60 * 60 * 1000) { void stop(); return; }
      if (status.state === 'recording') announce();
    }, 15000);
    initializing = initializeWorkers(token).catch(error => {
      if (token === generation && !stopped) announce({ ocrReady: false, message: '文字認識を起動できませんでした。拡張を再読み込みしてください。' });
      console.error('Local OCR initialization failed', error instanceof Error ? error.message : 'OCR error');
    });
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
  stopped = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (heartbeat) clearInterval(heartbeat);
  const endedAt = Date.now();
  endCurrent(endedAt);
  announce({ state: 'stopping', message: '最後のお題を保存しています' });
  // Stop the media tracks immediately; only already-cropped text awaits OCR.
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null;
  await initializing;
  await processQueue();
  if (currentCandidate) await finalizeCandidate(currentCandidate).catch(reportError);
  await Promise.all([...pendingWrites]);
  if (session) {
    session.endedAt = endedAt; session.durationMs = Math.max(0, endedAt - session.startedAt);
    await saveSession(session);
  }
  generation++;
  await Promise.all([jpWorker?.terminate(), romanWorker?.terminate()]);
  jpWorker = romanWorker = null; initializing = null;
  keyBuffer = []; focusGaps = []; queue = []; currentCandidate = undefined;
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
      if (message.sessionId === session?.id && Array.isArray(message.keys) && (status.state === 'recording' || status.state === 'stopping')) {
        keyBuffer.push(...message.keys);
        if (keyBuffer.length > MAX_KEY_BUFFER) {
          keyBuffer.splice(0, keyBuffer.length - MAX_KEY_BUFFER);
          if (currentCandidate) currentCandidate.reliableBoundary = false;
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
      if (Number.isFinite(message.at)) focusGaps.push(message.at);
      sendResponse({ ok: true }); return;
    case 'UCHI_OFF_CALIBRATE':
      if (!isCalibration(message.calibration)) { sendResponse({ ok: false }); return; }
      resetAutoRegions(Date.now(), false);
      calibration = message.calibration; manualRegions = true;
      lastVideoWidth = video.videoWidth; lastVideoHeight = video.videoHeight;
      lastSignature = pendingSignature = null; pendingCount = 0;
      announce({ regionState: 'manual', regionConfidence: undefined, region: undefined, message: captureWarning ?? (status.ocrReady ? '手動の範囲で読み取っています' : '文字認識を準備しています') });
      sendResponse({ ok: true }); return;
    default: return;
  }
  void task?.then(sendResponse).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '記録処理でエラーが発生しました。' }));
  return true;
});
