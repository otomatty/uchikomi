/** Images read from the permitted page's canvas surface, never game variables. */
export interface CanvasFrame {
  dataUrl: string;
  width: number;
  height: number;
  at: number;
  sequence: number;
}

export interface CanvasProducer {
  /** Resolves once muted playback can deliver frames. stop() also cancels startup. */
  ready: Promise<void>;
  stop(): void;
}

const SAMPLE_MS = 80;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1440;

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
  const video = canvas.ownerDocument.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const image = canvas.ownerDocument.createElement('canvas');
  const context = image.getContext('2d', { alpha: false });
  let stopped = false;
  let sending = false;
  let timer: number | undefined;
  let callback: number | undefined;
  let presented = -1;
  let captured = -1;
  let frameAt = 0;
  let sequence = 0;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) view.clearInterval(timer);
    if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    track.removeEventListener('mute', onMute);
    track.removeEventListener('ended', onEnded);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    video.pause();
    video.srcObject = null;
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

  async function sample() {
    if (stopped || sending || presented < 0 || presented === captured || !context || video.readyState < 2) return;
    if (canvas.ownerDocument.visibilityState !== 'visible') return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    if (image.width !== targetWidth) image.width = targetWidth;
    if (image.height !== targetHeight) image.height = targetHeight;
    sending = true;
    captured = presented;
    try {
      context.drawImage(video, 0, 0, targetWidth, targetHeight);
      const frame = { dataUrl: image.toDataURL('image/jpeg', .92), width: targetWidth, height: targetHeight, at: frameAt, sequence: ++sequence };
      await options.onFrame(frame);
    } catch (error) {
      if (!stopped) fail(error instanceof Error ? error : new Error('ゲーム画面を送信できませんでした。'));
    } finally {
      sending = false;
    }
  }

  function observeFrame(now: number, metadata: VideoFrameCallbackMetadata) {
    if (stopped) return;
    // Timers only sample a newly presented source frame. A frozen image never
    // counts as multiple independent observations of a prompt or a receipt.
    if (metadata.presentedFrames !== presented) {
      presented = metadata.presentedFrames;
      frameAt = view.performance.timeOrigin + now;
    }
    callback = video.requestVideoFrameCallback(observeFrame);
  }

  const ready = (async () => {
    if (!context || typeof video.requestVideoFrameCallback !== 'function') throw new Error('このブラウザではゲーム画面を自動で取得できません。');
    if (track.muted || track.readyState === 'ended') throw new Error('ゲーム画面を取得できませんでした。');
    await video.play();
    if (stopped) return;
    callback = video.requestVideoFrameCallback(observeFrame);
    timer = view.setInterval(() => { void sample(); }, SAMPLE_MS);
  })().catch(error => {
    stop();
    throw error;
  });
  return { ready, stop };
}
