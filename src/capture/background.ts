import { getData, updateSettings } from '../core/db';
import type { CaptureStatus, Calibration } from '../core/types';
import { EMPTY_CAPTURE } from '../core/types';
import { isAllowedGameUrl, isCalibration, isCaptureStroke } from './helpers';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const ORIGIN = chrome.runtime.getURL('');
const STOP_ERROR = '最後の記録を保存できませんでした。保存済みの履歴を確認してください。';
let status: CaptureStatus = { ...EMPTY_CAPTURE };
let stateLoaded = false;
let creating: Promise<void> | null = null;
let transitioning = false;

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
    if (stored.captureStatus && typeof stored.captureStatus === 'object') status = totalOnlyStatus(stored.captureStatus as CaptureStatus);
    stateLoaded = true;
  }
  return status;
}
async function publish(next: CaptureStatus) {
  status = totalOnlyStatus(next);
  stateLoaded = true;
  await chrome.storage.session.set({ captureStatus: status });
  void chrome.action.setBadgeText({ text: status.state === 'recording' ? '●' : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#ed6243' });
  void chrome.runtime.sendMessage({ type: 'UCHI_STATE', status }).catch(() => {});
}
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [OFFSCREEN_URL] });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA' as chrome.offscreen.Reason, 'WORKERS' as chrome.offscreen.Reason], justification: 'ユーザーが開始した寿司打の画面記録を、ローカルOCRで読み取るため。' }).finally(() => { creating = null; });
  }
  await creating;
}
async function offscreen<T = Record<string, unknown>>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
}
async function currentStatus(forceCheck = false) {
  await loadStatus();
  if ((status.state === 'recording' || status.state === 'starting') && (!transitioning || forceCheck)) {
    if (await hasOffscreen()) {
      const result = await offscreen<{ status?: CaptureStatus }>('UCHI_OFF_STATUS').catch(() => null);
      if (result?.status) status = totalOnlyStatus(result.status);
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
  if (transitioning) return { ok: false, error: '記録の準備中です。' };
  transitioning = true;
  let tab: chrome.tabs.Tab | null = null;
  try {
    const previous = await currentStatus(true);
    if (previous.state === 'recording') return { ok: true, status: previous };
    tab = await findGameTab(true);
    if (!tab?.id) return { ok: false, error: '寿司打のタブを開いて、拡張アイコンを押してください。' };
    const sessionId = crypto.randomUUID();
    const startedAt = Date.now();
    await publish({ state: 'starting', tabId: tab.id, sessionId, startedAt, phraseCount: 0, ocrReady: false, message: '記録を準備しています' });
    await ensureOffscreen();
    const { settings } = await getData();
    let enabled: unknown;
    try { enabled = await chrome.tabs.sendMessage(tab.id, { type: 'UCHI_CAPTURE_ENABLE', sessionId }); }
    catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
      enabled = await chrome.tabs.sendMessage(tab.id, { type: 'UCHI_CAPTURE_ENABLE', sessionId });
    }
    if (!enabled) throw new Error('寿司打を再読み込みして、もう一度記録してください。');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const response = await offscreen<{ ok: boolean; status?: CaptureStatus; error?: string }>('UCHI_OFF_START', { streamId, tabId: tab.id, sessionId, startedAt, settings });
    if (!response?.ok || !response.status) throw new Error(response?.error ?? '画面の記録を開始できませんでした。');
    await chrome.storage.session.set({ gameTabId: tab.id });
    await publish(response.status);
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
  } finally { transitioning = false; }
}
async function stopCapture(message?: string) {
  if (transitioning) return { ok: false, error: '記録の準備が終わってから停止してください。' };
  transitioning = true;
  try {
    await loadStatus();
    const ended = { ...status };
    let finalWarning: string | undefined;
    let stoppedSessionId = ended.activeSessionId ?? ended.sessionId;
    let stoppedStatus: CaptureStatus | undefined;
    if (ended.tabId) {
      await chrome.tabs.sendMessage(ended.tabId, { type: 'UCHI_CAPTURE_DISABLE' }).catch(() => {});
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
      latestScore: stoppedStatus?.latestScore, scoreState: stoppedStatus?.scoreState, scoreReviewSessionId: stoppedStatus?.scoreReviewSessionId,
      message: finalWarning ?? message });
    return { ok: true, status, sessionId: stoppedSessionId };
  } catch (error) {
    await chrome.offscreen.closeDocument().catch(() => {});
    await publish({ ...EMPTY_CAPTURE, state: 'error', message: conciseError(error, STOP_ERROR) });
    return { ok: false, error: status.message, status };
  } finally { transitioning = false; }
}

chrome.action.onClicked.addListener(tab => {
  // The open() call must stay in this user-gesture stack, before any await.
  if (tab.id) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (tab.id && isAllowedGameUrl(tab.url)) void chrome.storage.session.set({ gameTabId: tab.id });
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason !== 'install') return;
  void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void loadStatus().then(current => { if (current.tabId === tabId && current.state === 'recording') return stopCapture('タブを閉じたため記録を終了しました。'); });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  void loadStatus().then(current => {
    if (current.tabId === tabId && current.state === 'recording' && (changeInfo.status === 'loading' || (changeInfo.url && !isAllowedGameUrl(changeInfo.url)))) return stopCapture('ページが移動したため記録を終了しました。');
  });
});
chrome.tabCapture.onStatusChanged.addListener(info => {
  if (info.status !== 'stopped' && info.status !== 'error') return;
  void loadStatus().then(current => { if (!transitioning && current.tabId === info.tabId && current.state === 'recording') return stopCapture('画面共有が終了しました。'); });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || message.target === 'offscreen' || sender.id !== chrome.runtime.id) return;
  const fromOffscreen = sender.url?.split('?')[0] === OFFSCREEN_URL;
  const fromUI = !sender.tab && sender.url?.startsWith(ORIGIN) && !fromOffscreen;
  // Extension pages opened as full tabs have sender.tab, so check the URL, not tab presence.
  const trustedUI = fromUI || !!sender.url?.startsWith(ORIGIN + 'index.html') || !!sender.url?.startsWith(ORIGIN + 'sidepanel.html');
  if (fromOffscreen && message.type === 'UCHI_OFF_STATE') {
    if (message.status && typeof message.status.state === 'string') {
      const wasTab = status.tabId;
      void publish(message.status).then(async () => {
        if (message.status.state === 'idle' && wasTab) await chrome.tabs.sendMessage(wasTab, { type: 'UCHI_CAPTURE_DISABLE' }).catch(() => {});
        sendResponse({ ok: true });
        if (message.status.state === 'idle' && !transitioning) void chrome.offscreen.closeDocument().catch(() => {});
      });
    }
    else sendResponse({ ok: false });
    return true;
  }
  if (message.type === 'UCHI_CAPTURE_KEYS' || message.type === 'UCHI_CAPTURE_GAP' || message.type === 'UCHI_CAPTURE_VIEW_CHANGE') {
    if (!sender.tab?.id || !isAllowedGameUrl(sender.url)) return;
    void loadStatus().then(async current => {
      if (current.tabId !== sender.tab!.id || current.sessionId !== message.sessionId || !['recording', 'starting'].includes(current.state)) return;
      if (message.type === 'UCHI_CAPTURE_KEYS' && Array.isArray(message.keys)) {
        const keys = message.keys.slice(0, 100).filter(isCaptureStroke);
        if (keys.length) await offscreen('UCHI_OFF_KEYS', { sessionId: message.sessionId, keys });
      } else if (Number.isFinite(message.at)) await offscreen(message.type === 'UCHI_CAPTURE_VIEW_CHANGE' ? 'UCHI_OFF_VIEW_CHANGE' : 'UCHI_OFF_GAP', { at: message.at });
    }).catch(() => {});
    return;
  }
  if (!trustedUI) return;
  let task: Promise<unknown> | undefined;
  switch (message.type) {
    case 'UCHI_STATUS': task = currentStatus().then(status => ({ ok: true, status })); break;
    case 'UCHI_START': task = startCapture(); break;
    case 'UCHI_STOP': task = stopCapture(); break;
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
