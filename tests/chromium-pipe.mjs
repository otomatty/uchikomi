/**
 * QA-only Chrome ownership and Playwright's public ConnectOverCDPTransport.
 * One native pipe keeps Extensions.loadUnpacked available without opening a
 * debugging port or enabling Playwright's per-page focus emulation.
 */
import { spawn } from 'node:child_process';

/** Chrome's pipe protocol is UTF-8 JSON terminated by a NUL byte. */
export function createChromiumPipeTransport(pipeWrite, pipeRead) {
  let pending = [], closed = false, closeReason, closeCallback, notified = false;
  const notifyClose = () => {
    if (!closed || !closeCallback || notified) return;
    notified = true;
    // Deliver already received messages first, in their wire order.
    setImmediate(() => {
      const callback = closeCallback;
      if (!callback) { notified = false; return; }
      callback(closeReason);
    });
  };
  const transport = {
    onmessage: undefined,
    get onclose() { return closeCallback; },
    set onclose(callback) { closeCallback = callback; notifyClose(); },
    send(message) {
      if (closed) throw new Error('Chromium debugging pipe is closed');
      // Node streams retain buffered writes when their high-water mark is hit.
      pipeWrite.write(JSON.stringify(message) + '\0');
    },
    close(reason) {
      if (closed) return;
      closed = true;
      closeReason = reason;
      pending = [];
      pipeWrite.destroy();
      pipeRead.destroy();
      notifyClose();
    },
  };
  pipeRead.on('data', buffer => {
    if (closed) return;
    let start = 0;
    for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0, start)) {
      pending.push(buffer.subarray(start, end));
      let message;
      try {
        // Decode only complete messages, including UTF-8 split across chunks.
        message = JSON.parse(Buffer.concat(pending).toString('utf8'));
      } catch {
        transport.close('Chrome sent an invalid JSON pipe message');
        return;
      }
      const record = message !== null && typeof message === 'object' && !Array.isArray(message);
      const valid = record && (Object.hasOwn(message, 'id')
        ? Number.isSafeInteger(message.id) && message.id >= 0
        : typeof message.method === 'string' && message.method.trim().length > 0);
      if (!valid) {
        transport.close('Chrome sent an invalid CDP pipe message');
        return;
      }
      pending = [];
      setImmediate(() => transport.onmessage?.(message));
      start = end + 1;
    }
    if (start < buffer.length) pending.push(buffer.subarray(start));
  });
  pipeRead.once('end', () => transport.close());
  pipeRead.once('close', () => transport.close());
  pipeRead.once('error', error => transport.close(`Chrome pipe read failed: ${error.message}`));
  pipeWrite.once('error', error => transport.close(`Chrome pipe write failed: ${error.message}`));
  return transport;
}

/**
 * Configure downloads on the pipe's root session before Playwright attaches.
 * Download events belong to the CDP session that enables them; enabling them
 * on newBrowserCDPSession() would bypass Playwright's root-session listener.
 * ID 0 completes here before Playwright starts its own requests at ID 1.
 */
export function configureChromiumDownloads(transport, downloadPath, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const previousMessage = transport.onmessage, previousClose = transport.onclose;
    let settled = false, timer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.onmessage = previousMessage;
      transport.onclose = previousClose;
      if (error) reject(error); else resolve();
    };
    transport.onmessage = message => {
      if (message.id !== 0) return previousMessage?.(message);
      finish(message.error ? new Error(`Chrome download setup failed: ${message.error.message || 'CDP error'}`) : undefined);
    };
    transport.onclose = reason => {
      finish(new Error(`Chrome closed during download setup${reason ? `: ${reason}` : ''}`));
      previousClose?.(reason);
    };
    timer = setTimeout(() => {
      const error = new Error(`Chrome download setup did not respond within ${timeout} ms`);
      finish(error);
      transport.close(error.message);
    }, timeout);
    try {
      transport.send({ id: 0, method: 'Browser.setDownloadBehavior', params: {
        behavior: 'allowAndName', downloadPath, eventsEnabled: true,
      } });
    } catch (error) { finish(error); }
  });
}

// Preserve the former QA launch's relevant Playwright 1.65 defaults and its
// explicit extension/software-GPU flags. These apply only to a disposable
// profile. Focus and document.visibilityState are never emulated here.
const chromiumArgs = [
  '--disable-field-trial-config', '--disable-background-networking',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache', '--disable-breakpad',
  '--disable-component-extensions-with-background-pages', '--disable-component-update',
  '--no-default-browser-check', '--disable-default-apps', '--disable-dev-shm-usage',
  '--allow-pre-commit-input', '--disable-hang-monitor', '--disable-ipc-flooding-protection',
  '--disable-popup-blocking', '--disable-prompt-on-repost', '--disable-renderer-backgrounding',
  '--force-color-profile=srgb', '--metrics-recording-only', '--no-first-run',
  '--password-store=basic', '--use-mock-keychain', '--no-service-autorun',
  '--disable-search-engine-choice-screen', '--disable-stack-profiler', '--disable-infobars',
  '--disable-sync', '--no-sandbox', '--enable-unsafe-extension-debugging',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch',
  '--enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies',
];

export function startChromiumPipe({ executablePath, profileDir, headless = false }) {
  const args = [...chromiumArgs];
  if (headless) args.push('--headless', '--hide-scrollbars', '--mute-audio',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4');
  args.push(`--user-data-dir=${profileDir}`, '--remote-debugging-pipe', 'about:blank');
  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    // Own the process group so an abnormal Chrome exit cannot leave CI children.
    detached: process.platform !== 'win32',
  });
  const transport = createChromiumPipeTransport(child.stdio[3], child.stdio[4]);
  let stderr = '', exitResult, resolveExit, stopping;
  const signals = [];
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const finish = result => { if (!exitResult) { exitResult = result; resolveExit(); } };
  child.stderr.on('data', buffer => { stderr = (stderr + buffer.toString()).slice(-16000); });
  child.once('exit', (code, signal) => finish({ code, signal }));
  child.once('error', error => {
    finish({ error: error.message });
    transport.close(`Could not launch Chrome: ${error.message}`);
  });
  const signalChild = signal => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
      signals.push(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const killOnExit = () => { try { signalChild('SIGKILL'); } catch {} };
  process.once('exit', killOnExit);
  const waitForExit = async timeout => {
    if (exitResult) return true;
    let timer;
    try {
      return await Promise.race([
        exit.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  return {
    transport,
    diagnostics: () => ({ pid: child.pid, headless, transport: 'pipe', exit: exitResult, signals: [...signals], stderr }),
    stop() {
      return stopping ??= (async () => {
        try {
          // The caller sends Browser.close first. Bound every fallback wait.
          if (!await waitForExit(1500)) {
            signalChild('SIGTERM');
            if (!await waitForExit(2000)) {
              signalChild('SIGKILL');
              if (!await waitForExit(2000)) throw new Error('Owned Chrome process did not exit after SIGKILL');
            }
          }
        } finally {
          transport.close();
          // Clean up descendants even when the main process exited abnormally.
          killOnExit();
          process.removeListener('exit', killOnExit);
        }
      })();
    },
  };
}
