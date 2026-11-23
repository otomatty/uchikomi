/**
 * Prepended only to the disposable QA copy of content.js. These wrappers call
 * the real browser APIs unchanged and retain counters/metadata, never pixels.
 * This file is not part of the production build or its message protocol.
 */
(() => {
  if (globalThis.__uchikomiQaCapture) return;
  const state = globalThis.__uchikomiQaCapture = {
    trackProcessorAvailable: typeof globalThis.MediaStreamTrackProcessor === 'function',
    captureCalls: 0, tracks: [], videos: [], processors: [], messages: {},
  };
  const clock = () => performance.timeOrigin + performance.now();
  const errorText = error => String(error?.message || error);
  const create = document.createElement;
  document.createElement = function (...args) {
    const element = Reflect.apply(create, this, args);
    if (String(args[0]).toLowerCase() === 'video') {
      const observed = { element, playCalls: 0, playState: 'not-called', callbacks: 0, callbackRequests: 0 };
      state.videos.push(observed);
      const play = element.play;
      element.play = function (...args) {
        observed.playCalls++; observed.playState = 'pending';
        const result = Reflect.apply(play, this, args);
        return result.then(value => { observed.playState = 'fulfilled'; return value; }, error => {
          observed.playState = 'rejected'; observed.error = errorText(error); throw error;
        });
      };
      const request = element.requestVideoFrameCallback;
      if (typeof request === 'function') element.requestVideoFrameCallback = function (callback) {
        observed.callbackRequests++;
        return Reflect.apply(request, this, [(now, metadata) => {
          observed.callbacks++;
          observed.lastFrame = { now, at: clock(), presentedFrames: metadata.presentedFrames, mediaTime: metadata.mediaTime,
            width: metadata.width, height: metadata.height };
          return callback(now, metadata);
        }]);
      };
    }
    return element;
  };
  const capture = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function (...args) {
    state.captureCalls++;
    try {
      const stream = Reflect.apply(capture, this, args);
      for (const track of stream.getVideoTracks()) state.tracks.push({ track, createdAt: clock(), width: this.width, height: this.height });
      return stream;
    } catch (error) { state.captureError = errorText(error); throw error; }
  };
  const Processor = globalThis.MediaStreamTrackProcessor;
  if (typeof Processor === 'function') {
    const ObservedProcessor = function (...args) {
      const processor = Reflect.construct(Processor, args);
      const observed = { createdAt: clock(), reads: 0, frames: 0, ended: false, maxBufferSize: args[0]?.maxBufferSize };
      state.processors.push(observed);
      const stream = processor.readable, getReader = stream.getReader;
      stream.getReader = function (...args) {
        const reader = Reflect.apply(getReader, this, args), read = reader.read;
        reader.read = function (...args) {
          observed.reads++;
          return Reflect.apply(read, this, args).then(result => {
            if (result.done) observed.ended = true;
            if (result.value) {
              observed.frames++;
              observed.lastFrame = { timestamp: result.value.timestamp, width: result.value.displayWidth,
                height: result.value.displayHeight, at: clock() };
            }
            return result;
          }, error => { observed.error = errorText(error); throw error; });
        };
        return reader;
      };
      return processor;
    };
    ObservedProcessor.prototype = Processor.prototype;
    Object.setPrototypeOf(ObservedProcessor, Processor);
    globalThis.MediaStreamTrackProcessor = ObservedProcessor;
  }
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function (...args) {
    const message = args[0], type = message?.type;
    let observed;
    if (['UCHI_CANVAS_READY', 'UCHI_CANVAS_FRAME', 'UCHI_CANVAS_END'].includes(type)) {
      observed = state.messages[type] ??= { sent: 0, replies: 0, dropped: 0, failed: 0 };
      observed.sent++;
      observed.lastSent = { at: clock(), sessionId: message.sessionId, reason: message.reason, error: message.error,
        ...(message.frame ? { sequence: message.frame.sequence, frameAt: message.frame.at, width: message.frame.width,
          height: message.frame.height, imageCharacters: message.frame.dataUrl?.length } : {}) };
    }
    const result = Reflect.apply(send, this, args);
    if (!observed || !result?.then) return result;
    return result.then(reply => {
      observed.replies++;
      if (reply?.dropped) observed.dropped++;
      if (!reply?.ok) observed.failed++;
      observed.lastReply = { at: clock(), ok: reply?.ok, dropped: reply?.dropped, error: reply?.error, sessionId: reply?.sessionId };
      return reply;
    }, error => { observed.failed++; observed.error = errorText(error); throw error; });
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'UCHI_QA_CAPTURE_DIAGNOSTICS') return;
    respond({
      at: clock(), visible: !document.hidden, focused: document.hasFocus(), trackProcessorAvailable: state.trackProcessorAvailable,
      captureCalls: state.captureCalls, captureError: state.captureError, messages: state.messages,
      tracks: state.tracks.slice(-4).map(({ track, ...metadata }) => ({ ...metadata, readyState: track.readyState,
        muted: track.muted, enabled: track.enabled, settings: track.getSettings() })),
      videos: state.videos.slice(-4).map(({ element, ...metadata }) => {
        const quality = element.getVideoPlaybackQuality();
        return { ...metadata, connected: element.isConnected, readyState: element.readyState, paused: element.paused,
          currentTime: element.currentTime, width: element.videoWidth, height: element.videoHeight,
          quality: { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames,
            creationTime: quality.creationTime } };
      }),
      processors: state.processors.slice(-4),
    });
  });
})();
