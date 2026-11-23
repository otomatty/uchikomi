import { getSettings, updateSettings } from '../core/db';
import type { CaptureStatus, Calibration } from '../core/types';
import { EMPTY_CAPTURE } from '../core/types';
import { isAllowedGameUrl, isCalibration, isCaptureStroke } from './helpers';
import { isReplayShortcut } from '../core/shortcuts';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const ORIGIN = chrome.runtime.getURL('');
const STOP_ERROR = '最後の記録を保存できませんでした。保存済みの履歴を確認してください。';
let status: CaptureStatus = { ...EMPTY_CAPTURE };
let stateLoaded = false;
let creating: Promise<void> | null = null;
let transitioning = false;
let transitionDone: Promise<void> | null = null;
let cancelStart = false;
let stopping: Promise<any> | null = null;
let forwardingFrame: { sessionId: string; sequence: number } | null = null;
let preparingReplay: object | null = null;

function beginTransition() {
  transitioning = true;
  let release!: () => void;
  transitionDone = new Promise<void>(resolve => { release = resolve; });
  return () => { transitioning = false; transitionDone = null; release(); };
}
function withOwner(next: CaptureStatus, previous = status): CaptureStatus {
  if (!next.sessionId || next.sessionId !== previous.sessionId) return totalOnlyStatus(next);
  return totalOnlyStatus({ ...next, source: previous.source ?? next.source, tabId: previous.tabId ?? next.tabId,
    frameId: previous.frameId, documentId: previous.documentId, documentToken: previous.documentToken });
}
function ownsCanvas(current: CaptureStatus, sender: chrome.runtime.MessageSender, message: { documentToken?: string; sessionId?: string }, requireSession = true) {
  return current.source === 'canvas' && current.tabId === sender.tab?.id && current.frameId === (sender.frameId ?? 0) &&
    (!current.documentId || current.documentId === sender.documentId) && current.documentToken === message.documentToken &&
    (!requireSession || current.sessionId === message.sessionId);
}
function contentTarget(current: CaptureStatus): chrome.tabs.MessageSendOptions | undefined {
  return current.source === 'canvas' ? { ...(current.documentId ? { documentId: current.documentId } : { frameId: current.frameId ?? 0 }) } : undefined;
}
function validCanvasFrame(frame: any): boolean {
  return frame && Number.isInteger(frame.width) && Number.isInteger(frame.height) && frame.width >= 1 && frame.width <= 1920 && frame.height >= 1 && frame.height <= 1440 &&
    Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 && Number.isFinite(frame.at) && Math.abs(Date.now() - frame.at) < 30000 &&
    typeof frame.dataUrl === 'string' && frame.dataUrl.length <= 3000000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame.dataUrl);
}

function totalOnlyStatus(value: CaptureStatus): CaptureStatus {
  // Session storage is only a live notification cache. Never relabel an old
  // difference-based notification as a total; canonical records migrate in DB.
  if (value.latestScore && value.latestScore.scoreType !== 'total') {
    const { latestScore: _legacy, ...rest } = value;
    return rest;
  }
  return value;
}
async function loadStatus() {
  if (!stateLoaded) {
    const stored = await chrome.storage.session.get('captureStatus');
    // Another message may have loaded/published a new owner while this read
    // was pending. Never replace that live owner with a stale storage result.
    if (!stateLoaded) {
      if (stored.captureStatus && typeof stored.captureStatus === 'object') status = totalOnlyStatus(stored.captureStatus as CaptureStatus);
      stateLoaded = true;
    }
  }
  return status;
}
async function publish(next: CaptureStatus) {
  status = totalOnlyStatus(next);
  stateLoaded = true;
  await chrome.storage.session.set({ captureStatus: status });
  void chrome.action.setBadgeText({ text: status.state === 'recording' ? '●' : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#778679' });
  void chrome.runtime.sendMessage({ type: 'UCHI_STATE', status }).catch(() => {});
}
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [OFFSCREEN_URL] });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA' as chrome.offscreen.Reason, 'WORKERS' as chrome.offscreen.Reason], justification: '表示中の寿司打のゲーム画面を、端末内のOCRで読み取るため。' }).finally(() => { creating = null; });
  }
  await creating;
}
async function offscreen<T = Record<string, unknown>>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
}
async function currentStatus(forceCheck = false) {
  await loadStatus();
  if ((status.state === 'recording' || status.state === 'starting') && (!transitioning || forceCheck)) {
    const expectedSession = status.sessionId, expectedState = status.state;
    if (await hasOffscreen()) {
      const result = await offscreen<{ status?: CaptureStatus }>('UCHI_OFF_STATUS').catch(() => null);
      if (result?.status && result.status.sessionId === expectedSession && status.sessionId === expectedSession &&
          status.state === expectedState && (!transitioning || forceCheck)) status = withOwner(result.status);
    } else {
      await publish({ ...EMPTY_CAPTURE, state: 'error', message: '記録が中断されました。もう一度開始してください。' });
    }
  }
  return status;
}
async function findGameTab(requireActive = false): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id && isAllowedGameUrl(active.url)) return active;
  if (requireActive) return null;
  const stored = await chrome.storage.session.get('gameTabId');
  if (typeof stored.gameTabId === 'number') {
    const remembered = await chrome.tabs.get(stored.gameTabId).catch(() => null);
    if (remembered?.id && isAllowedGameUrl(remembered.url)) return remembered;
  }
  const tabs = await chrome.tabs.query({ url: ['https://sushida.net/*', 'https://www.sushida.net/*'] });
  return tabs.find(tab => /\/play(?:\.html|\/)/.test(tab.url ?? '')) ?? tabs[0] ?? null;
}
function conciseError(error: unknown, fallback = '記録を開始できませんでした。寿司打のタブで再試行してください。'): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invoked|activeTab|not been granted|permission|not allowed|Cannot capture|active tab/i.test(message)) return '寿司打のタブで拡張アイコンを押してから記録してください。';
  if (/Could not establish connection|Receiving end does not exist/i.test(message)) return '寿司打を再読み込みして、もう一度記録してください。';
  return message.length < 180 ? message : fallback;
}
async function startCapture() {
  if (transitioning || stopping) return { ok: false, error: '記録の準備中です。' };
  const release = beginTransition(); cancelStart = false;
  let tab: chrome.tabs.Tab | null = null;
  try {
    const previous = await currentStatus(true);
    if (previous.state === 'recording') return { ok: true, status: previous };
    tab = await findGameTab(true);
    if (!tab?.id) return { ok: false, error: '寿司打のタブを開いて、拡張アイコンを押してください。' };
    const sessionId = crypto.randomUUID();
    const startedAt = Date.now();
    await publish({ state: 'starting', source: 'tab', tabId: tab.id, sessionId, startedAt, phraseCount: 0, ocrReady: false, message: '記録を準備しています' });
    await ensureOffscreen();
    const settings = await getSettings();
    if (cancelStart) return { ok: true, status };
    let enabled: { ok?: boolean; documentToken?: string } | undefined;
    try { enabled = await chrome.tabs.sendMessage(tab.id, { type: 'UCHI_CAPTURE_ENABLE', sessionId, replayShortcut: settings.replayShortcut }); }
    catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
      enabled = await chrome.tabs.sendMessage(tab.id, { type: 'UCHI_CAPTURE_ENABLE', sessionId, replayShortcut: settings.replayShortcut });
    }
    if (!enabled) throw new Error('寿司打を再読み込みして、もう一度記録してください。');
    if (typeof enabled.documentToken === 'string') status = { ...status, documentToken: enabled.documentToken };
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    if (cancelStart) return { ok: true, status };
    const response = await offscreen<{ ok: boolean; status?: CaptureStatus; error?: string }>('UCHI_OFF_START', { source: 'tab', streamId, tabId: tab.id, sessionId, startedAt, settings });
    if (!response?.ok || !response.status) throw new Error(response?.error ?? '画面の記録を開始できませんでした。');
    await chrome.storage.session.set({ gameTabId: tab.id });
    await publish(withOwner(response.status));
    return { ok: true, status };
  } catch (error) {
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'UCHI_CAPTURE_DISABLE' }).catch(() => {});
    if (await hasOffscreen()) {
      await offscreen('UCHI_OFF_STOP').catch(() => {});
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    const message = conciseError(error);
    await publish({ ...EMPTY_CAPTURE, state: 'error', message });
    return { ok: false, error: message, status };
  } finally { release(); }
}
async function startCanvas(sender: chrome.runtime.MessageSender, documentToken: string) {
  if (transitioning || stopping) return { ok: true, busy: true };
  const release = beginTransition(); cancelStart = false;
  let started = false;
  try {
    const settings = await getSettings();
    if (!settings.autoRecord) return { ok: true, paused: true };
    const previous = await currentStatus(true);
    if (['recording', 'starting'].includes(previous.state)) {
      return ownsCanvas(previous, sender, { documentToken }, false)
        ? { ok: true, sessionId: previous.sessionId, replayShortcut: settings.replayShortcut } : { ok: true, busy: true };
    }
    const tab = await chrome.tabs.get(sender.tab!.id!).catch(() => null);
    if (!tab?.active || !isAllowedGameUrl(tab.url) || cancelStart) return { ok: true, busy: true };
    const sessionId = crypto.randomUUID(), startedAt = Date.now();
    await publish({ ...EMPTY_CAPTURE, state: 'starting', source: 'canvas', tabId: tab.id, frameId: sender.frameId ?? 0,
      documentId: sender.documentId, documentToken, sessionId, startedAt, ocrReady: false, message: '自動記録を準備しています' });
    started = true;
    await ensureOffscreen();
    if (cancelStart) return { ok: true, busy: true };
    const response = await offscreen<{ ok: boolean; status?: CaptureStatus; error?: string }>('UCHI_OFF_START', {
      source: 'canvas', tabId: tab.id, sessionId, startedAt, settings,
    });
    if (!response?.ok || !response.status) throw new Error(response?.error ?? '自動記録を開始できませんでした。');
    await chrome.storage.session.set({ gameTabId: tab.id });
    await publish(withOwner(response.status));
    return cancelStart ? { ok: true, busy: true } : { ok: true, sessionId, replayShortcut: settings.replayShortcut };
  } catch (error) {
    const message = conciseError(error);
    // A competing page's failed preference/status read does not own the
    // running offscreen document and cannot erase its persisted owner.
    if (!started) return { ok: false, error: message };
    if (await hasOffscreen()) {
      await offscreen('UCHI_OFF_STOP').catch(() => {});
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    await publish({ ...EMPTY_CAPTURE, state: 'error', message });
    return { ok: false, error: message };
  } finally { release(); }
}
function stopCapture(message?: string): Promise<any> {
  cancelStart = true;
  if (stopping) return stopping;
  stopping = (async () => {
    if (transitionDone) await transitionDone;
    return finishStop(message);
  })().finally(() => { stopping = null; });
  return stopping;
}
async function finishStop(message?: string) {
  const release = beginTransition();
  try {
    await loadStatus();
    const ended = { ...status };
    let finalWarning: string | undefined;
    let stoppedSessionId = ended.activeSessionId ?? ended.sessionId;
    let stoppedStatus: CaptureStatus | undefined;
    if (ended.tabId) {
      await chrome.tabs.sendMessage(ended.tabId, { type: 'UCHI_CAPTURE_DISABLE' }, contentTarget(ended)).catch(() => {});
      // Let each permitted frame's final key batch reach the offscreen buffer.
      await new Promise(resolve => setTimeout(resolve, 160));
    }
    if (await hasOffscreen()) {
      await publish({ ...status, state: 'stopping', message: '最後のお題を保存しています' });
      const stopped = await offscreen<{ ok?: boolean; error?: string; status?: CaptureStatus; sessionId?: string }>('UCHI_OFF_STOP');
      if (stopped?.ok !== true) throw new Error(typeof stopped?.error === 'string' && stopped.error.trim() ? stopped.error : STOP_ERROR);
      finalWarning = stopped?.status?.message;
      stoppedSessionId = stopped?.sessionId ?? stoppedSessionId;
      stoppedStatus = stopped?.status;
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    await publish({ ...EMPTY_CAPTURE, sessionId: ended.sessionId, activeSessionId: stoppedSessionId, phraseCount: status.phraseCount,
      latestScore: stoppedStatus?.latestScore ?? ended.latestScore, scoreState: stoppedStatus?.scoreState ?? ended.scoreState, scoreReviewSessionId: stoppedStatus?.scoreReviewSessionId ?? ended.scoreReviewSessionId,
      message: finalWarning ?? message });
    return { ok: true, status, sessionId: stoppedSessionId };
  } catch (error) {
    await chrome.offscreen.closeDocument().catch(() => {});
    await publish({ ...EMPTY_CAPTURE, state: 'error', message: conciseError(error, STOP_ERROR) });
    return { ok: false, error: status.message, status };
  } finally { release(); }
}

async function probeGameTabs(inject = false) {
  const tabs = await chrome.tabs.query({ url: ['https://sushida.net/*', 'https://www.sushida.net/*'] });
  await Promise.allSettled(tabs.filter(tab => inject || tab.active).map(async tab => {
    if (!tab.id) return;
    if (inject) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
    await chrome.tabs.sendMessage(tab.id, { type: 'UCHI_CANVAS_PROBE' }).catch(() => {});
  }));
}
async function pauseCapture() {
  await updateSettings({ autoRecord: false });
  return stopCapture('自動記録を一時停止しています。');
}
async function resumeCapture() {
  await updateSettings({ autoRecord: true });
  if (stopping) await stopping;
  await probeGameTabs(true);
  return { ok: true, status };
}
function ownsReplay(current: CaptureStatus, sender: chrome.runtime.MessageSender, message: { sessionId?: string; documentToken?: string }) {
  if (current.source === 'canvas') return ownsCanvas(current, sender, message);
  return current.source === 'tab' && current.tabId === sender.tab?.id && current.sessionId === message.sessionId &&
    !!current.documentToken && current.documentToken === message.documentToken;
}
async function replayFromContent(message: { sessionId?: string; documentToken?: string; shortcut?: unknown; at?: unknown }, sender: chrome.runtime.MessageSender) {
  if (!isReplayShortcut(message.shortcut) || message.shortcut === 'Escape' ||
      typeof message.at !== 'number' || !Number.isFinite(message.at) || Math.abs(Date.now() - message.at) > 2000) return { ok: true, ready: false };
  const current = await loadStatus();
  if (preparingReplay || transitioning || stopping || current.state !== 'recording' || !ownsReplay(current, sender, message)) return { ok: true, ready: false };
  const pending = {}; preparingReplay = pending;
  try {
    const settings = await getSettings();
    if (settings.replayShortcut !== message.shortcut) return { ok: true, ready: false };
    const tab = await chrome.tabs.get(sender.tab!.id!).catch(() => null);
    if (!tab?.active || !isAllowedGameUrl(tab.url) || status.state !== 'recording' || !ownsReplay(status, sender, message)) return { ok: true, ready: false };
    const result = await offscreen<{ ok?: boolean; ready?: boolean; error?: string; reason?: string }>('UCHI_OFF_REPLAY', { sessionId: message.sessionId });
    // Saving/OCR may take time. A changed owner, paused capture or updated
    // shortcut must invalidate the reply before any key reaches the game.
    if (!result?.ok || !result.ready) return { ...result, ready: false };
    if (stopping || transitioning || status.state !== 'recording' || !ownsReplay(status, sender, message) ||
        (await getSettings()).replayShortcut !== message.shortcut) return { ok: true, ready: false };
    return { ok: true, ready: true, sessionId: message.sessionId };
  } finally { if (preparingReplay === pending) preparingReplay = null; }
}
async function refreshReplaySettings() {
  const settings = await getSettings(), current = await loadStatus();
  if (current.tabId && current.sessionId && ['starting', 'recording'].includes(current.state)) {
    await chrome.tabs.sendMessage(current.tabId, { type: 'UCHI_REPLAY_SETTINGS', sessionId: current.sessionId,
      documentToken: current.documentToken, replayShortcut: settings.replayShortcut }, contentTarget(current)).catch(() => {});
  }
  return { ok: true };
}

chrome.action.onClicked.addListener(tab => {
  // The open() call must stay in this user-gesture stack, before any await.
  if (tab.id) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (tab.id && isAllowedGameUrl(tab.url)) void chrome.storage.session.set({ gameTabId: tab.id });
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  // Already-open game tabs also receive the new observer after an update.
  void probeGameTabs(true).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  void loadStatus().then(current => { if (current.tabId === tabId && ['starting', 'recording'].includes(current.state)) return stopCapture('タブを閉じたため記録を終了しました。'); });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  void loadStatus().then(current => {
    if (current.tabId === tabId && ['starting', 'recording'].includes(current.state) && (changeInfo.status === 'loading' || (changeInfo.url && !isAllowedGameUrl(changeInfo.url)))) return stopCapture('ページが移動したため記録を終了しました。');
  });
});
chrome.tabCapture.onStatusChanged.addListener(info => {
  if (info.status !== 'stopped' && info.status !== 'error') return;
  void loadStatus().then(current => { if (!transitioning && current.source !== 'canvas' && current.tabId === info.tabId && current.state === 'recording') return stopCapture('画面共有が終了しました。'); });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || message.target === 'offscreen' || sender.id !== chrome.runtime.id) return;
  const fromOffscreen = sender.url?.split('?')[0] === OFFSCREEN_URL;
  const fromUI = !sender.tab && sender.url?.startsWith(ORIGIN) && !fromOffscreen;
  // Extension pages opened as full tabs have sender.tab, so check the URL, not tab presence.
  const trustedUI = fromUI || !!sender.url?.startsWith(ORIGIN + 'index.html') || !!sender.url?.startsWith(ORIGIN + 'sidepanel.html');
  if (fromOffscreen && message.type === 'UCHI_OFF_STATE') {
    void loadStatus().then(async current => {
      const next = message.status as CaptureStatus | undefined;
      if (!next || !['idle', 'starting', 'recording', 'stopping', 'error'].includes(next.state)) return { ok: false };
      // Late worker notifications must never revive a stopped/older document.
      if (!['starting', 'recording', 'stopping'].includes(current.state) || next.sessionId !== current.sessionId ||
          (current.state === 'stopping' && ['starting', 'recording'].includes(next.state))) return { ok: true, dropped: true };
      await publish(withOwner(next, current));
      if (['idle', 'error'].includes(next.state) && !transitioning) await stopCapture(next.message);
      return { ok: true };
    }).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (['UCHI_CANVAS_READY', 'UCHI_CANVAS_FRAME', 'UCHI_CANVAS_END'].includes(message.type)) {
    if (!sender.tab?.id || !isAllowedGameUrl(sender.url) || typeof message.documentToken !== 'string' ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(message.documentToken)) return;
    const task = message.type === 'UCHI_CANVAS_READY' ? startCanvas(sender, message.documentToken) : (async () => {
      const current = await loadStatus();
      if (!ownsCanvas(current, sender, message) || !['recording', 'starting'].includes(current.state)) return { ok: false, error: '記録は終了しています。' };
      if (message.type === 'UCHI_CANVAS_FRAME') {
        if (!validCanvasFrame(message.frame)) return { ok: false, error: '読み取り画像を確認できませんでした。' };
        if (forwardingFrame?.sessionId === message.sessionId) return { ok: true, dropped: true };
        const slot = { sessionId: message.sessionId as string, sequence: message.frame.sequence as number };
        forwardingFrame = slot;
        try { return await offscreen('UCHI_OFF_CANVAS_FRAME', { sessionId: message.sessionId, frame: message.frame }); }
        finally { if (forwardingFrame === slot) forwardingFrame = null; }
      }
      const failed = message.reason === 'error';
      const result = await stopCapture(failed ? 'ゲーム画面を取得できませんでした。寿司打を再読み込みしてください。' : undefined);
      if (failed && result.ok) await publish({ ...status, state: 'error', message: typeof message.error === 'string' ? conciseError(message.error) : 'ゲーム画面を取得できませんでした。' });
      return result;
    })();
    void task.then(sendResponse).catch(error => sendResponse({ ok: false, error: conciseError(error) }));
    return true;
  }
  if (message.type === 'UCHI_CAPTURE_REPLAY') {
    if (!sender.tab?.id || !isAllowedGameUrl(sender.url) || typeof message.documentToken !== 'string') return;
    void replayFromContent(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, ready: false, error: conciseError(error, '記録を保存できないため、再プレイを待っています。') }));
    return true;
  }
  if (message.type === 'UCHI_CAPTURE_KEYS' || message.type === 'UCHI_CAPTURE_GAP' || message.type === 'UCHI_CAPTURE_VIEW_CHANGE') {
    if (!sender.tab?.id || !isAllowedGameUrl(sender.url)) return;
    void loadStatus().then(async current => {
      if (current.tabId !== sender.tab!.id || current.sessionId !== message.sessionId || !['recording', 'starting'].includes(current.state)) return { ok: false };
      if (current.source === 'canvas' && !ownsCanvas(current, sender, message)) return { ok: false };
      if (message.type === 'UCHI_CAPTURE_KEYS' && Array.isArray(message.keys)) {
        const keys = message.keys.slice(0, 100).filter(isCaptureStroke);
        if (keys.length) await offscreen('UCHI_OFF_KEYS', { sessionId: message.sessionId, keys });
      } else if (Number.isFinite(message.at)) await offscreen(message.type === 'UCHI_CAPTURE_VIEW_CHANGE' ? 'UCHI_OFF_VIEW_CHANGE' : 'UCHI_OFF_GAP', { sessionId: message.sessionId, at: message.at });
      return { ok: true };
    }).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!trustedUI) return;
  let task: Promise<unknown> | undefined;
  switch (message.type) {
    case 'UCHI_STATUS': task = currentStatus().then(status => ({ ok: true, status })); break;
    case 'UCHI_START': task = startCapture(); break;
    case 'UCHI_STOP': task = pauseCapture(); break;
    case 'UCHI_RESUME': task = resumeCapture(); break;
    case 'UCHI_REPLAY_SETTINGS_CHANGED': task = refreshReplaySettings(); break;
    case 'UCHI_FRAME': task = (async () => {
      if (!(await hasOffscreen())) return { ok: false, error: '記録を開始してから読み取り範囲を設定してください。' };
      return offscreen('UCHI_OFF_FRAME');
    })(); break;
    case 'UCHI_AUTO_REGION': task = (async () => {
      if (!(await hasOffscreen())) return { ok: false, error: '記録を開始してから再検出してください。' };
      return offscreen('UCHI_OFF_AUTO_REGION');
    })(); break;
    case 'UCHI_CALIBRATE': task = (async () => {
      if (!isCalibration(message.calibration)) return { ok: false, error: '文字が収まる範囲を選択してください。' };
      const calibration = message.calibration as Calibration;
      await updateSettings({ calibration });
      if (await hasOffscreen()) await offscreen('UCHI_OFF_CALIBRATE', { calibration });
      return { ok: true };
    })(); break;
    case 'UCHI_OPEN_GAME': task = (async () => {
      const tab = await findGameTab();
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.storage.session.set({ gameTabId: tab.id });
      } else {
        const created = await chrome.tabs.create({ url: 'https://sushida.net/play.html' });
        if (created.id) await chrome.storage.session.set({ gameTabId: created.id });
      }
      return { ok: true };
    })(); break;
    default: return;
  }
  void task?.then(sendResponse).catch(error => sendResponse({ ok: false, error: conciseError(error) }));
  return true;
});
