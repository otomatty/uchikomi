import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startOcrWorkers } from '../src/capture/ocr-worker.ts';

export async function startCheckWorkers(root, report) {
  try {
    return await startOcrWorkers(['eng','jpn'], {
      // Overrides keep missing-model regression tests isolated from packaged assets.
      langPath: process.env.UCHIKOMI_OCR_LANG_PATH || path.join(root,'dist/vendor/lang'),
      gzip: true, cacheMethod: 'none',
    });
  } catch (error) { report.startupFailed = true; throw error; }
}

export async function finishOcrCheck(root, filename, report, workers) {
  const results=await Promise.allSettled(workers.filter(Boolean).map(worker=>Promise.resolve().then(()=>worker.terminate())));
  const failures=results.filter(result=>result.status==='rejected');
  if(failures.length){report.cleanupErrors=failures.map(result=>String(result.reason));process.exitCode=1;}
  const directory=process.env.UCHIKOMI_OCR_REPORT_DIR || path.join(root,'qa');
  try {
    await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,filename),JSON.stringify(report,null,2));
  } finally {
    // Tesseract does not expose a permanently pending startup's worker_threads
    // handle. After persisting the failure, end this dedicated CLI process so
    // that its hidden worker cannot keep the check running indefinitely.
    if(report.startupFailed)process.exit(1);
  }
}
