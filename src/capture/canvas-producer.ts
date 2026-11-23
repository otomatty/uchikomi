/** Images read from the permitted page's canvas surface, never game variables. */
export interface CanvasFrame {
  dataUrl: string;
  width: number;
  height: number;
  at: number;
  sequence: number;
}

export interface CanvasProducer {
  /** Resolves once the frame consumer is ready. stop() also cancels startup. */
  ready: Promise<void>;
  stop(): void;
}

const SAMPLE_MS = 80;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1440;
type TrackProcessorConstructor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => { readable: ReadableStream<VideoFrame> };

export function visibleGameCanvas(document: Document): HTMLCanvasElement | null {
  const view = document.defaultView;
  if (!view || document.visibilityState !== 'visible') return null;
  const candidates = [...document.querySelectorAll('canvas')].filter(canvas => {
    if (!canvas.isConnected || canvas.width <= 0 || canvas.height <= 0) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 200 || rect.height <= 100 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth) return false;
    // A canvas hidden by an ancestor is not a visible game surface yet.
    // No canvas pixels or game state are read during discovery.
    for (let element: Element | null = canvas; element; element = element.parentElement) {
      const style = view.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  });
  candidates.sort((a, b) => {
    const left = a.getBoundingClientRect();
    const right = b.getBoundingClientRect();
    return right.width * right.height - left.width * left.height;
  });
  return candidates[0] ?? null;
}

export function createCanvasProducer(
  canvas: HTMLCanvasElement,
  options: { onFrame(frame: CanvasFrame): Promise<void>; onError(error: Error): void },
): CanvasProducer {
  if (typeof canvas.captureStream !== 'function') throw new Error('このブラウザではゲーム画面を自動で取得できません。');
  // captureStream reads the painted surface. Reading the source canvas with
  // drawImage/toDataURL would be unreliable for preserveDrawingBuffer:false.
  // The browser enforces origin-clean here; a SecurityError is never bypassed.
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach(item => item.stop());
    throw new Error('ゲーム画面を取得できませんでした。');
  }
  const view = canvas.ownerDocument.defaultView!;
  const Processor = (view as Window & { MediaStreamTrackProcessor?: TrackProcessorConstructor }).MediaStreamTrackProcessor;
  // A detached video's presentation callbacks can be suspended independently
  // of the source track. Chromium's track processor consumes actual source
  // frames without requiring video playback or a visible media element.
  const video = typeof Processor === 'function' ? undefined : canvas.ownerDocument.createElement('video');
  if (video) {
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.srcObject = stream;
  }
  const image = canvas.ownerDocument.createElement('canvas');
  const context = image.getContext('2d', { alpha: false });
  let stopped = false;
  let sending = false;
  let timer: number | undefined;
  let firstFrameTimer: number | undefined;
  let callback: number | undefined;
  let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  let presented = -1;
  let captured = -1;
  let frameAt = 0;
  let sequence = 0;
  let cancelStartup!: () => void;
  const cancelled = new Promise<void>(resolve => { cancelStartup = resolve; });

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelStartup();
    if (timer !== undefined) view.clearInterval(timer);
    if (firstFrameTimer !== undefined) view.clearTimeout(firstFrameTimer);
    if (callback !== undefined) video?.cancelVideoFrameCallback(callback);
    if (reader) { const activeReader = reader; reader = undefined; void activeReader.cancel().catch(() => {}); }
    track.removeEventListener('mute', onMute);
    track.removeEventListener('ended', onEnded);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    if (video) { video.pause(); video.srcObject = null; }
    stream.getTracks().forEach(item => item.stop());
    image.width = 0;
    image.height = 0;
  }
  function fail(message: string | Error) {
    if (stopped) return;
    stop();
    options.onError(message instanceof Error ? message : new Error(message));
  }
  function onMute() { fail('ゲーム画面の取得が中断されました。寿司打を再表示して再開してください。'); }
  function onEnded() { fail('ゲーム画面の取得が終了しました。寿司打を再表示して再開してください。'); }
  function onContextLost() { fail('ゲームの描画が中断されました。復帰後に寿司打を再表示してください。'); }
  track.addEventListener('mute', onMute);
  track.addEventListener('ended', onEnded);
  canvas.addEventListener('webglcontextlost', onContextLost);

  function encode(source: CanvasImageSource, width: number, height: number, at: number): CanvasFrame {
    const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    if (image.width !== targetWidth) image.width = targetWidth;
    if (image.height !== targetHeight) image.height = targetHeight;
    context!.drawImage(source, 0, 0, targetWidth, targetHeight);
    return { dataUrl: image.toDataURL('image/jpeg', .92), width: targetWidth, height: targetHeight, at, sequence: ++sequence };
  }
  function acknowledged() {
    if (firstFrameTimer !== undefined) { view.clearTimeout(firstFrameTimer); firstFrameTimer = undefined; }
  }
  async function readFrames(activeReader: ReadableStreamDefaultReader<VideoFrame>) {
    let lastTimestamp = -Infinity;
    try {
      while (!stopped) {
        const { value, done } = await activeReader.read();
        if (done) { if (!stopped) fail('ゲーム画面の取得が終了しました。寿司打を再表示して再開してください。'); return; }
        let frame: CanvasFrame | undefined;
        try {
          if (stopped || canvas.ownerDocument.visibilityState !== 'visible') continue;
          // Each encoded image must come from a new source VideoFrame, not a
          // timer tick or another read of the same frozen pixels.
          if (!Number.isFinite(value.timestamp) || value.timestamp <= lastTimestamp) continue;
          lastTimestamp = value.timestamp;
          if (!value.displayWidth || !value.displayHeight) continue;
          // Media timestamps have a source-specific origin. Use the same epoch
          // clock as key events at receipt; a single-frame queue bounds delay.
          frame = encode(value, value.displayWidth, value.displayHeight, view.performance.timeOrigin + view.performance.now());
        } finally { value.close(); }
        // Release GPU-backed frames before waiting for the offscreen response.
        // Awaiting the response keeps only one JPEG message in flight.
        if (frame && !stopped) { await options.onFrame(frame); acknowledged(); }
      }
    } finally {
      if (reader === activeReader) { reader = undefined; await activeReader.cancel().catch(() => {}); }
      activeReader.releaseLock();
    }
  }

  async function sample() {
    if (stopped || sending || !video || presented < 0 || presented === captured || !context || video.readyState < 2) return;
    if (canvas.ownerDocument.visibilityState !== 'visible') return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    sending = true;
    captured = presented;
    try {
      await options.onFrame(encode(video, width, height, frameAt));
      acknowledged();
    } catch (error) {
      if (!stopped) fail(error instanceof Error ? error : new Error('ゲーム画面を送信できませんでした。'));
    } finally {
      sending = false;
    }
  }

  function observeFrame(now: number, metadata: VideoFrameCallbackMetadata) {
    if (stopped || !video) return;
    // Timers only sample a newly presented source frame. A frozen image never
    // counts as multiple independent observations of a prompt or a receipt.
    if (metadata.presentedFrames !== presented) {
      presented = metadata.presentedFrames;
      frameAt = view.performance.timeOrigin + now;
    }
    callback = video.requestVideoFrameCallback(observeFrame);
  }

  const initialize = async () => {
    if (!context) throw new Error('このブラウザではゲーム画面を自動で取得できません。');
    if (track.muted || track.readyState === 'ended') throw new Error('ゲーム画面を取得できませんでした。');
    firstFrameTimer = view.setTimeout(() => fail('ゲーム画面を読み取れませんでした。寿司打を再表示して再開してください。'), FIRST_FRAME_TIMEOUT_MS);
    if (typeof Processor === 'function') {
      reader = new Processor({ track, maxBufferSize: 1 }).readable.getReader();
      void readFrames(reader).catch(error => { if (!stopped) fail(error instanceof Error ? error : new Error('ゲーム画面を取得できませんでした。')); });
      return;
    }
    if (!video || typeof video.requestVideoFrameCallback !== 'function') throw new Error('このブラウザではゲーム画面を自動で取得できません。');
    await video.play();
    if (stopped) return;
    callback = video.requestVideoFrameCallback(observeFrame);
    timer = view.setInterval(() => { void sample(); }, SAMPLE_MS);
  };
  const ready = Promise.race([initialize(), cancelled]).catch(error => {
    stop();
    throw error;
  });
  return { ready, stop };
}
