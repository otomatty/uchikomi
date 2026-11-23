/**
 * Prepended only to the disposable QA background/offscreen bundles. Observe
 * real API boundaries without changing production messages, frame contents,
 * decoding choices or acknowledgement timing. No image/key data is retained.
 */
(() => {
  if (globalThis.__uchikomiQaRouting) return;
  const context = location.pathname.endsWith('/offscreen.html') ? 'offscreen' : 'background';
  const clock = () => performance.timeOrigin + performance.now();
  const state = globalThis.__uchikomiQaRouting = {
    context, startedAt: clock(), received: {}, sent: {}, imageDecodes: { calls: 0, pending: 0, fulfilled: 0, rejected: 0 },
    bitmaps: { calls: 0, pending: 0, fulfilled: 0, rejected: 0 }, events: [], offscreenEvents: [],
  };
  const send = chrome.runtime.sendMessage;
  const traced = new Set(['UCHI_CANVAS_READY', 'UCHI_CANVAS_FRAME', 'UCHI_CANVAS_END',
    'UCHI_OFF_START', 'UCHI_OFF_CANVAS_FRAME', 'UCHI_OFF_STOP']);
  const errorText = error => String(error?.message || error);
  const messageMeta = message => ({ type: message.type, sessionId: message.sessionId, target: message.target,
    ...(message.frame ? { sequence: message.frame.sequence, frameAt: message.frame.at, width: message.frame.width,
      height: message.frame.height, imageCharacters: message.frame.dataUrl?.length } : {}) });
  const responseMeta = reply => ({ ok: reply?.ok, dropped: reply?.dropped, error: reply?.error,
    sessionId: reply?.sessionId, ...(reply?.status ? { status: { state: reply.status.state, source: reply.status.source,
      sessionId: reply.status.sessionId, lastFrameAt: reply.status.lastFrameAt, ocrReady: reply.status.ocrReady,
      regionState: reply.status.regionState, phraseCount: reply.status.phraseCount } } : {}) });
  let forwarded = 0;
  const record = (stage, metadata = {}) => {
    const event = { at: clock(), stage, ...metadata };
    state.events.push(event); if (state.events.length > 64) state.events.shift();
    // Keep the first decoder events in the service worker even if a failed
    // first frame causes the actual offscreen document to close before QA polls.
    if (context === 'offscreen' && forwarded++ < 64) {
      try { void Promise.resolve(Reflect.apply(send, chrome.runtime, [{
        type: 'UCHI_QA_PIPELINE_TRACE', context, event,
      }])).catch(() => {}); } catch { /* Diagnostics never control capture. */ }
    }
  };
  chrome.runtime.sendMessage = function (...args) {
    const message = args[0], type = message?.type;
    let observed;
    if (typeof type === 'string' && (type.startsWith('UCHI_OFF_') || type.startsWith('UCHI_CANVAS_'))) {
      observed = state.sent[type] ??= { calls: 0, pending: 0, fulfilled: 0, rejected: 0 };
      observed.calls++; observed.pending++; observed.lastSent = { at: clock(), ...messageMeta(message) };
      if (traced.has(type)) record('send', messageMeta(message));
    }
    let result;
    try { result = Reflect.apply(send, this, args); }
    catch (error) {
      if (observed) { observed.pending--; observed.rejected++; observed.error = errorText(error); }
      throw error;
    }
    if (!observed || !result?.then) return result;
    return result.then(reply => {
      observed.pending--; observed.fulfilled++; observed.lastReply = { at: clock(), ...responseMeta(reply) };
      if (traced.has(type)) record('reply', { type, ...responseMeta(reply) });
      return reply;
    }, error => {
      observed.pending--; observed.rejected++; observed.error = errorText(error);
      if (traced.has(type)) record('rejected', { type, error: observed.error });
      throw error;
    });
  };
  // A separate passive listener preserves the production handler and its
  // sendResponse callback. Only the two QA-only message types respond here.
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message) return;
    if (message.type === 'UCHI_QA_ROUTING_DIAGNOSTICS' && message.context === context) {
      respond({ ...state, at: clock() }); return;
    }
    if (context === 'background' && message.type === 'UCHI_QA_PIPELINE_TRACE' &&
        message.context === 'offscreen' && sender.url === chrome.runtime.getURL('offscreen.html')) {
      state.offscreenEvents.push(message.event);
      if (state.offscreenEvents.length > 64) state.offscreenEvents.shift();
      respond({ ok: true }); return;
    }
    const type = message.type;
    const intended = context === 'offscreen' ? message.target === 'offscreen' : message.target !== 'offscreen';
    if (!intended || typeof type !== 'string' || (!type.startsWith('UCHI_OFF_') && !type.startsWith('UCHI_CANVAS_'))) return;
    const observed = state.received[type] ??= { calls: 0 };
    observed.calls++; observed.last = { at: clock(), ...messageMeta(message),
      senderUrl: sender.url, hasTab: !!sender.tab, frameId: sender.frameId };
    if (traced.has(type)) record('receive', messageMeta(message));
  });
  if (context !== 'offscreen') return;
  const imageDecode = globalThis.HTMLImageElement?.prototype.decode;
  if (typeof imageDecode === 'function') HTMLImageElement.prototype.decode = function (...args) {
    const observed = state.imageDecodes, startedAt = clock();
    observed.calls++; observed.pending++; observed.lastStartedAt = startedAt;
    record('image-decode-start', { sourceCharacters: this.src.length });
    return Reflect.apply(imageDecode, this, args).then(value => {
      observed.pending--; observed.fulfilled++; observed.lastFinishedAt = clock();
      record('image-decode-resolved', { startedAt, width: this.naturalWidth, height: this.naturalHeight });
      return value;
    }, error => {
      observed.pending--; observed.rejected++; observed.error = errorText(error);
      record('image-decode-rejected', { startedAt, error: observed.error }); throw error;
    });
  };
  const bitmap = globalThis.createImageBitmap;
  if (typeof bitmap === 'function') globalThis.createImageBitmap = function (...args) {
    const observed = state.bitmaps, startedAt = clock(), source = args[0];
    observed.calls++; observed.pending++; observed.lastStartedAt = startedAt;
    record('bitmap-decode-start', { sourceType: source?.constructor?.name,
      bytes: source instanceof Blob ? source.size : undefined, mimeType: source instanceof Blob ? source.type : undefined });
    let result;
    try { result = Reflect.apply(bitmap, this, args); }
    catch (error) {
      observed.pending--; observed.rejected++; observed.error = errorText(error);
      record('bitmap-decode-threw', { startedAt, error: observed.error }); throw error;
    }
    return result.then(value => {
      observed.pending--; observed.fulfilled++; observed.lastFinishedAt = clock();
      record('bitmap-decode-resolved', { startedAt, width: value.width, height: value.height });
      return value;
    }, error => {
      observed.pending--; observed.rejected++; observed.error = errorText(error);
      record('bitmap-decode-rejected', { startedAt, error: observed.error }); throw error;
    });
  };
})();
