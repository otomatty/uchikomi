import { createWorker as createTesseractWorker, type Worker, type WorkerOptions } from 'tesseract.js';

type Languages = Parameters<typeof createTesseractWorker>[0];
export interface OcrStartupOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable only to exercise callback-only failures and delayed startup. */
  createWorker?: typeof createTesseractWorker;
}

function startupError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value ?? 'OCR initialization failed'));
}
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('OCR initialization was cancelled'); error.name = 'AbortError'; return error;
}
function dispose(worker: Worker): void {
  try { void Promise.resolve(worker.terminate()).catch(() => {}); } catch { /* Best-effort cleanup of a failed startup. */ }
}

/**
 * Tesseract 7 reports loadLanguage/initialize failures through errorHandler but
 * can leave createWorker pending. Own startup settlement instead of awaiting it
 * forever. The underlying worker is not public until createWorker resolves:
 * callers must close its owning offscreen document (or Node CLI process) when
 * cancelling a permanently pending startup. Obtained/late workers are terminated.
 */
export function startOcrWorker(langs: Languages, options: Partial<WorkerOptions> = {}, controls: OcrStartupOptions = {}): Promise<Worker> {
  const { signal, timeoutMs = 45000 } = controls;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError('OCR startup timeout must be positive'));
  return new Promise((resolve, reject) => {
    let pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const fail = (error: unknown) => {
      if (!pending) return;
      pending = false; cleanup(); reject(startupError(error));
    };
    const onAbort = () => fail(abortError(signal!));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => fail(new Error(`OCR initialization timed out after ${timeoutMs} ms`)), timeoutMs);
    let created: Promise<Worker>;
    try {
      created = (controls.createWorker ?? createTesseractWorker)(langs, 1, {
        ...options,
        errorHandler(error: unknown) {
          fail(error);
          // Runtime errors still reach the caller after successful startup.
          try { options.errorHandler?.(error); } catch { /* Do not throw into Tesseract's message handler. */ }
        },
      });
    } catch (error) { fail(error); return; }
    void Promise.resolve(created).then(worker => {
      if (!pending) { dispose(worker); return; }
      pending = false; cleanup(); resolve(worker);
    }, fail);
  });
}

/** All-or-nothing ownership: a failed startup cancels and releases its siblings. */
export async function startOcrWorkers(langs: readonly Languages[], options: Partial<WorkerOptions> = {}, controls: OcrStartupOptions = {}): Promise<Worker[]> {
  if (!langs.length) throw new Error('At least one OCR language is required');
  const controller = new AbortController(), acquired = new Set<Worker>();
  const onAbort = () => controller.abort(controls.signal?.reason);
  if (controls.signal?.aborted) onAbort();
  else controls.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const workers = await Promise.all(langs.map(lang => startOcrWorker(lang, options, { ...controls, signal: controller.signal }).then(worker => {
      if (controller.signal.aborted) { dispose(worker); throw abortError(controller.signal); }
      acquired.add(worker); return worker;
    })));
    if (controller.signal.aborted) throw abortError(controller.signal);
    return workers;
  } catch (error) {
    controller.abort(error);
    for (const worker of acquired) dispose(worker);
    throw error;
  } finally {
    controls.signal?.removeEventListener('abort', onAbort);
  }
}
