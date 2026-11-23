/** Passive observer. No key event is synthesized, cancelled, or sent back to the game. */
(() => {
  const scope = globalThis as typeof globalThis & { __uchikomiObserver?: boolean };
  if (scope.__uchikomiObserver) return;
  scope.__uchikomiObserver = true;
  let sessionId: string | null = null;
  let gameFocused = false;
  let buffer: { key: string; code: string; at: number }[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const safeSend = (message: unknown) => chrome.runtime.sendMessage(message).catch(() => {});

  function isEditable(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]');
  }
  function canvasFor(target: EventTarget | null): HTMLCanvasElement | null {
    if (target instanceof HTMLCanvasElement) return target;
    if (target instanceof Element) return target.closest('canvas');
    return null;
  }
  function flush() {
    if (!sessionId || !buffer.length) return;
    const keys = buffer;
    buffer = [];
    void safeSend({ type: 'UCHI_CAPTURE_KEYS', sessionId, keys });
  }
  function endFocus() {
    flush();
    if (gameFocused && sessionId) void safeSend({ type: 'UCHI_CAPTURE_GAP', sessionId, at: Date.now() });
    gameFocused = false;
  }
  function onKey(event: KeyboardEvent) {
    if (!sessionId || !event.isTrusted || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus() || isEditable(event.target)) return;
    if (!gameFocused && !(document.activeElement instanceof HTMLCanvasElement)) return;
    if (event.key.length !== 1 || !/^[a-zA-Z0-9!?.,\-'/:;()\[\] ]$/.test(event.key)) return;
    buffer.push({ key: event.key.toLowerCase(), code: event.code, at: performance.timeOrigin + performance.now() });
    if (buffer.length >= 40) flush();
  }
  window.addEventListener('keydown', onKey, { capture: true });
  document.addEventListener('pointerdown', event => { if (canvasFor(event.target)) gameFocused = true; else endFocus(); }, { capture: true });
  window.addEventListener('blur', endFocus);
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  const viewChanged = () => {
    if (!sessionId) return;
    if (viewTimer) clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { if (sessionId) void safeSend({ type: 'UCHI_CAPTURE_VIEW_CHANGE', sessionId, at: Date.now() }); }, 120);
  };
  window.addEventListener('scroll', viewChanged, { passive: true });
  window.addEventListener('resize', viewChanged, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') endFocus(); });
  window.addEventListener('pagehide', () => { flush(); sessionId = null; if (timer) clearInterval(timer); });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return;
    if (message.type === 'UCHI_CAPTURE_ENABLE' && typeof message.sessionId === 'string') {
      buffer = [];
      sessionId = message.sessionId;
      gameFocused = document.activeElement instanceof HTMLCanvasElement;
      if (timer) clearInterval(timer);
      timer = setInterval(flush, 90);
      sendResponse({ ok: true, canvasCount: document.querySelectorAll('canvas').length });
    } else if (message.type === 'UCHI_CAPTURE_DISABLE') {
      flush(); sessionId = null; gameFocused = false;
      if (timer) clearInterval(timer);
      sendResponse({ ok: true });
    } else if (message.type === 'UCHI_CAPTURE_GEOMETRY') {
      const canvases = [...document.querySelectorAll('canvas')].map(canvas => canvas.getBoundingClientRect()).filter(r => r.width > 200 && r.height > 100).sort((a, b) => b.width * b.height - a.width * a.height);
      const r = canvases[0];
      sendResponse({ ok: true, width: innerWidth, height: innerHeight, canvas: r ? { x: r.x / innerWidth, y: r.y / innerHeight, width: r.width / innerWidth, height: r.height / innerHeight } : null });
    }
  });
})();
