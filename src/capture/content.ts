import { createCanvasProducer, visibleGameCanvas, type CanvasProducer } from './canvas-producer';

/** Passive observer. No key event is synthesized, cancelled, or sent back to the game. */
(() => {
  const scope = globalThis as typeof globalThis & { __uchikomiObserver?: boolean | string };
  // Permit injection over the old manual-only observer after an extension
  // update, while keeping repeated injections of this version idempotent.
  const observerVersion = `automatic-canvas-${chrome.runtime.getManifest().version}`;
  if (scope.__uchikomiObserver === observerVersion) return;
  scope.__uchikomiObserver = observerVersion;
  const documentToken = crypto.randomUUID();
  let sessionId: string | null = null;
  let captureMode: 'canvas' | 'tab' | null = null;
  let captureCanvas: HTMLCanvasElement | null = null;
  let producer: CanvasProducer | null = null;
  let generation = 0;
  let probing = false;
  let probeAgain = false;
  let retryBlocked = false;
  let pageHidden = false;
  let gameFocused = false;
  let buffer: { key: string; code: string; at: number }[] = [];
  let pendingKeys: Promise<unknown> = Promise.resolve();
  let timer: number | undefined;
  let probeTimer: number | undefined;
  const safeSend = async (message: unknown) => {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return undefined; }
  };

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]');
  }
  function canvasFor(target: EventTarget | null): HTMLCanvasElement | null {
    if (target instanceof HTMLCanvasElement) return target;
    if (target instanceof Element) return target.closest('canvas');
    return null;
  }
  function isGameCanvas(target: EventTarget | null): boolean {
    const canvas = canvasFor(target);
    return !!canvas && (!captureCanvas || canvas === captureCanvas);
  }
  function flush() {
    if (!sessionId || !buffer.length) return pendingKeys;
    const keys = buffer;
    buffer = [];
    const message = { type: 'UCHI_CAPTURE_KEYS', sessionId, documentToken, keys };
    pendingKeys = Promise.all([pendingKeys, safeSend(message)]).then(() => undefined);
    return pendingKeys;
  }
  function endFocus() {
    flush();
    if (gameFocused && sessionId) void safeSend({ type: 'UCHI_CAPTURE_GAP', sessionId, documentToken, at: Date.now() });
    gameFocused = false;
  }
  function enableKeys(id: string, mode: 'canvas' | 'tab') {
    if (sessionId === id && captureMode === mode) return;
    flush();
    sessionId = id; captureMode = mode;
    gameFocused = isGameCanvas(document.activeElement);
    if (timer !== undefined) window.clearInterval(timer);
    timer = window.setInterval(flush, 90);
  }
  function disable() {
    ++generation;
    flush();
    sessionId = null; captureMode = null;
    gameFocused = false;
    if (timer !== undefined) window.clearInterval(timer);
    if (viewTimer !== undefined) window.clearTimeout(viewTimer);
    timer = undefined;
    viewTimer = undefined;
    producer?.stop();
    producer = null;
    captureCanvas = null;
  }
  async function endCapture(reason: 'hidden' | 'removed' | 'pagehide' | 'error', error?: string) {
    const endingSession = sessionId, endingMode = captureMode;
    if (reason === 'error') retryBlocked = true;
    disable();
    if (endingSession && endingMode === 'canvas') {
      await pendingKeys;
      await safeSend({ type: 'UCHI_CANVAS_END', sessionId: endingSession, documentToken, reason, ...(error ? { error } : {}) });
    }
  }

  async function probe() {
    if (probing) { probeAgain = true; return; }
    if (pageHidden || document.visibilityState !== 'visible' || retryBlocked) return;
    probing = true;
    try {
      const canvas = visibleGameCanvas(document);
      if (captureCanvas && captureCanvas !== canvas) await endCapture('removed');
      if (!canvas || sessionId || pageHidden || document.visibilityState !== 'visible' || retryBlocked) return;
      const requestGeneration = generation;
      const reply = await safeSend({ type: 'UCHI_CANVAS_READY', documentToken });
      if (!reply?.ok || typeof reply.sessionId !== 'string') return;
      if (requestGeneration !== generation || pageHidden || document.visibilityState !== 'visible' || visibleGameCanvas(document) !== canvas) {
        await safeSend({ type: 'UCHI_CANVAS_END', sessionId: reply.sessionId, documentToken, reason: pageHidden ? 'pagehide' : document.visibilityState !== 'visible' ? 'hidden' : 'removed' });
        return;
      }
      captureCanvas = canvas;
      enableKeys(reply.sessionId, 'canvas');
      const startedSession = reply.sessionId;
      const startedGeneration = generation;
      try {
        const running = createCanvasProducer(canvas, {
          async onFrame(frame) {
            if (startedGeneration !== generation || sessionId !== startedSession) return;
            const response = await safeSend({ type: 'UCHI_CANVAS_FRAME', sessionId: startedSession, documentToken, frame });
            if (startedGeneration !== generation || sessionId !== startedSession) return;
            if (!response?.ok) throw new Error(typeof response?.error === 'string' ? response.error : 'ゲーム画面の記録に接続できませんでした。');
          },
          onError(error) {
            if (startedGeneration === generation && sessionId === startedSession) void endCapture('error', error.message);
          },
        });
        producer = running;
        void running.ready.catch(error => {
          if (startedGeneration === generation && sessionId === startedSession) {
            void endCapture('error', error instanceof Error ? error.message : 'ゲーム画面を取得できませんでした。');
          }
        });
      } catch (error) {
        await endCapture('error', error instanceof Error ? error.message : 'ゲーム画面を取得できませんでした。');
      }
    } finally {
      probing = false;
      if (probeAgain) { probeAgain = false; void probe(); }
    }
  }
  function onKey(event: KeyboardEvent) {
    if (!sessionId || !event.isTrusted || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus() || isEditable(event.target)) return;
    if (!gameFocused && !isGameCanvas(document.activeElement)) return;
    if (event.key.length !== 1 || !/^[a-zA-Z0-9!?.,\-'/:;()\[\] ]$/.test(event.key)) return;
    buffer.push({ key: event.key.toLowerCase(), code: event.code, at: performance.timeOrigin + performance.now() });
    if (buffer.length >= 40) flush();
  }
  window.addEventListener('keydown', onKey, { capture: true });
  document.addEventListener('pointerdown', event => { if (isGameCanvas(event.target)) gameFocused = true; else endFocus(); }, { capture: true });
  // Keyboard navigation can move focus without a pointer event (for example,
  // Tab from the game to a page button). Stop treating those keys as gameplay.
  document.addEventListener('focusin', event => { if (isGameCanvas(event.target) && !isEditable(event.target)) gameFocused = true; else endFocus(); }, { capture: true });
  window.addEventListener('blur', endFocus);
  let viewTimer: number | undefined;
  const viewChanged = () => {
    if (viewTimer !== undefined) window.clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => {
      if (sessionId) void safeSend({ type: 'UCHI_CAPTURE_VIEW_CHANGE', sessionId, documentToken, at: Date.now() });
      void probe();
    }, 120);
  };
  window.addEventListener('scroll', viewChanged, { passive: true });
  window.addEventListener('resize', viewChanged, { passive: true });
  const observer = new window.MutationObserver(() => { void probe(); });
  function observe() {
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'width', 'height'] });
    if (probeTimer === undefined) probeTimer = window.setInterval(() => { void probe(); }, 2500);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      endFocus();
      // Manual tabCapture owns its media lifecycle in the background. Retain
      // its key subscription so returning to the game resumes the same capture.
      if (captureMode !== 'tab') void endCapture('hidden');
    }
    else { retryBlocked = false; void probe(); }
  });
  window.addEventListener('pagehide', () => {
    pageHidden = true;
    endFocus();
    void endCapture('pagehide');
    observer.disconnect();
    if (probeTimer !== undefined) window.clearInterval(probeTimer);
    probeTimer = undefined;
  });
  window.addEventListener('pageshow', () => {
    pageHidden = false;
    retryBlocked = false;
    observe();
    void probe();
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return;
    if (message.documentToken && message.documentToken !== documentToken) return;
    if (message.type === 'UCHI_CAPTURE_ENABLE' && typeof message.sessionId === 'string') {
      if (captureMode !== 'tab' || sessionId !== message.sessionId) {
        // Also invalidate a pending automatic READY reply before enabling the
        // manual fallback; it must not replace this subscription on arrival.
        disable();
        enableKeys(message.sessionId, 'tab');
      }
      sendResponse({ ok: true, canvasCount: document.querySelectorAll('canvas').length });
    } else if (message.type === 'UCHI_CAPTURE_DISABLE') {
      disable();
      sendResponse({ ok: true });
    } else if (message.type === 'UCHI_CANVAS_PROBE') {
      retryBlocked = false;
      void probe();
      sendResponse({ ok: true, documentToken });
    } else if (message.type === 'UCHI_CAPTURE_GEOMETRY') {
      const canvases = [...document.querySelectorAll('canvas')].map(canvas => canvas.getBoundingClientRect()).filter(r => r.width > 200 && r.height > 100).sort((a, b) => b.width * b.height - a.width * a.height);
      const r = canvases[0];
      sendResponse({ ok: true, width: innerWidth, height: innerHeight, canvas: r ? { x: r.x / innerWidth, y: r.y / innerHeight, width: r.width / innerWidth, height: r.height / innerHeight } : null });
    }
  });
  observe();
  void probe();
})();
