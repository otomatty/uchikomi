/**
 * Reproducible QA for the unpacked extension. Never uses an existing Chrome profile.
 * npm run build && node tests/browser-check.mjs
 * HEADLESS=0 CHROME_BIN=/path/to/chrome node tests/browser-check.mjs
 * Screenshots/report are internal QA artifacts, not product assets.
 */
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'qa');
const temp = await mkdtemp(path.join(os.tmpdir(), 'uchikomi-qa-'));
const extension = path.join(temp, 'extension');
const report = { startedAt: new Date().toISOString(), fixtureOnly: true, checks: [], errors: [], browserErrors: [] };
let context;
const run = async (name, fn) => {
  try { await fn(); report.checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (e) { report.checks.push({ name, ok: false, error: String(e.message || e) }); throw e; }
};

try {
  await mkdir(output, { recursive: true });
  await cp(path.join(root, 'dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  await run('MV3 manifest / locally packaged OCR assets', async () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.content_security_policy.extension_pages.includes('wasm-unsafe-eval'));
    assert.ok(!manifest.host_permissions?.includes('<all_urls>'));
    assert.ok(!JSON.stringify(manifest).includes('http://*/*'));
    for (const asset of ['vendor/worker.min.js', 'vendor/lang/eng.traineddata.gz', 'vendor/lang/jpn.traineddata.gz', 'index.html', 'sidepanel.html', 'offscreen.html']) await access(path.join(extension, asset));
    assert.ok(manifest.background?.service_worker);
    await access(path.join(extension, manifest.background.service_worker));
  });

  // A test-only harness in a temporary COPY of the extension. Never ships in dist.
  await build({
    stdin: {
      contents: `
        export * from ${JSON.stringify(path.join(root, 'src/core/db.ts'))};
        import { detectPromptRegions } from ${JSON.stringify(path.join(root, 'src/capture/auto-region.ts'))};
        export async function detectPromptFromImage(dataUrl) {
          const image=new Image(); image.src=dataUrl; await image.decode();
          const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
          const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0);
          return detectPromptRegions(ctx.getImageData(0,0,canvas.width,canvas.height));
        }
        export { createMatcher } from ${JSON.stringify(path.join(root, 'src/core/romaji.ts'))};
        import { createWorker } from 'tesseract.js';
        export async function ocrSmoke() {
          const canvas=document.createElement('canvas'); canvas.width=600; canvas.height=110;
          const ctx=canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,600,110);
          ctx.fillStyle='#111'; ctx.font='52px monospace'; ctx.fillText('pearukku',30,75);
          const worker=await createWorker('eng',1,{
            workerPath:chrome.runtime.getURL('vendor/worker.min.js'),
            corePath:chrome.runtime.getURL('vendor/core/'),
            langPath:chrome.runtime.getURL('vendor/lang/'),
            workerBlobURL:false, cacheMethod:'none', gzip:true
          });
          try {
            await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'abcdefghijklmnopqrstuvwxyz'});
            const result=await worker.recognize(canvas);
            return {text:result.data.text.trim(),confidence:result.data.confidence};
          } finally {await worker.terminate();}
        }
      `,
      resolveDir: root, sourcefile: 'qa-harness.ts', loader: 'ts',
    },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'UchiQA', target: 'es2022', outfile: path.join(extension, 'qa-harness.js'),
  });
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    // The bundled Chromium channel supports extensions in new headless mode.
    // The default headless shell does not load an extension service worker.
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chromium' }),
    headless: process.env.HEADLESS !== '0',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  // All website requests are blocked; only the independent local fixture is served.
  const fixture = await readFile(path.join(root, 'tests/capture-fixture.html'), 'utf8');
  await context.route(/^https?:\/\//, async route => {
    if (route.request().url() === 'https://sushida.net/play.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
    return route.abort('blockedbyclient');
  });
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(serviceWorker.url()).host;
  const app = await context.newPage();
  app.on('pageerror', error => report.browserErrors.push(error.message));
  await app.goto(`chrome-extension://${extensionId}/index.html`);
  await app.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
  await app.addScriptTag({ url: `chrome-extension://${extensionId}/qa-harness.js` });

  await run('Initial user data is empty (no synthetic records)', async () => {
    const data = await app.evaluate(() => window.UchiQA.getData());
    assert.equal(data.phrases.length, 0); assert.equal(data.attempts.length, 0); assert.equal(data.sessions.length, 0);
    assert.equal(data.settings.targetScore, 30000); assert.equal(data.settings.targetDate, '2026-12-25');
    assert.ok((await app.locator('body').innerText()).includes('UCHIKOMI'));
  });
  await run('Desktop layout and keyboard focus', async () => {
    assert.ok(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'desktop overflow');
    await app.keyboard.press('Tab');
    assert.ok(await app.evaluate(() => document.activeElement !== document.body), 'keyboard focus did not advance');
    await app.screenshot({ path: path.join(output, 'desktop-empty.png'), fullPage: true });
  });
  await run('Packaged OCR worker and WASM work offline under extension CSP', async () => {
    const result = await app.evaluate(() => window.UchiQA.ocrSmoke());
    assert.equal(result.text, 'pearukku'); assert.ok(result.confidence >= 60);
    report.ocrFixture = result;
  });

  await run('Automatic prompt bounds from a full browser screenshot, including page margins', async () => {
    const game = await context.newPage();
    await game.goto('https://sushida.net/play.html');
    await game.evaluate(() => document.fonts.ready);
    const image = 'data:image/png;base64,'+(await game.screenshot()).toString('base64');
    const detected = await app.evaluate(dataUrl => window.UchiQA.detectPromptFromImage(dataUrl), image);
    assert.ok(detected && detected.confidence > .8, 'independent prompt was not detected');
    const expected = await game.evaluate(() => {
      const r=document.querySelector('canvas').getBoundingClientRect();
      return {x:(r.x+150*r.width/900)/innerWidth,y:(r.y+190*r.height/560)/innerHeight,width:600*r.width/900/innerWidth,height:172*r.height/560/innerHeight};
    });
    for (const key of ['x','y','width','height']) assert.ok(Math.abs(detected.panel[key]-expected[key])<.015, 'incorrect '+key);
    assert.ok(detected.reading.y<detected.japanese.y && detected.japanese.y<detected.roman.y);
    await game.getByRole('button',{name:'空画面',exact:true}).click();
    const blank='data:image/png;base64,'+(await game.screenshot()).toString('base64');
    assert.equal(await app.evaluate(dataUrl => window.UchiQA.detectPromptFromImage(dataUrl), blank),null);
    await game.close();
  });

  const now = Date.now();
  const imported = {
    version: 1, exportedAt: now,
    settings: { targetScore: 30000, baselineScore: 18000, targetDate: '2026-12-25', scoreType: 'profit', sessionLength: 10, includeUnverified: false },
    phrases: [
      { id: 'qa-phrase-1', text: 'テスト用のペアルック', reading: 'ぺあるっく', roman: 'pearukku', source: 'manual', confidence: 100, verified: true, capturedAt: now, lastSeenAt: now, seenCount: 1 },
      { id: 'qa-phrase-2', text: 'テスト用の写真', reading: 'しゃしん', roman: 'syasinn', source: 'manual', confidence: 100, verified: true, capturedAt: now, lastSeenAt: now, seenCount: 1 },
    ],
    attempts: [], sessions: [],
  };
  await run('Atomic validated import and export', async () => {
    await app.evaluate(value => window.UchiQA.importData(value), imported);
    const data = await app.evaluate(() => window.UchiQA.exportData());
    assert.equal(data.version, 1); assert.equal(data.phrases.length, 2); assert.equal(data.attempts.length, 0);
    const before = JSON.stringify({ phrases: data.phrases, sessions: data.sessions, settings: data.settings });
    const rejected = await app.evaluate(async () => {
      try { await window.UchiQA.importData({ version: 1, phrases: [{ id: 'invalid', roman: null }] }); return false; }
      catch { return true; }
    });
    assert.equal(rejected, true);
    const after = await app.evaluate(() => window.UchiQA.exportData());
    assert.equal(JSON.stringify({ phrases: after.phrases, sessions: after.sessions, settings: after.settings }), before);
  });
  await run('Data survives reload', async () => {
    await app.reload();
    await app.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
    await app.addScriptTag({ url: `chrome-extension://${extensionId}/qa-harness.js` });
    const data = await app.evaluate(() => window.UchiQA.getData());
    assert.equal(data.phrases.length, 2);
  });
  await run('Japanese alternative romaji paths in browser', async () => {
    const states = await app.evaluate(() => {
      return [['しゃしん', 'syasinn', 'shashinn'], ['ぺあるっく','pearukku','pearultuku']].map(([kana, roman, typed]) => {
        const matcher = window.UchiQA.createMatcher(kana, roman);
        const accepted = [...typed].every(k => matcher.feed(k).accepted);
        return accepted && matcher.complete;
      });
    });
    assert.deepEqual(states, [true, true]);
  });
  await run('A selected saved keyword completes a five-word practice through the actual UI', async () => {
    await app.getByTestId('nav-phrases').click();
    await app.getByRole('button', { name: 'テスト用のペアルックを復習', exact: true }).click();
    await app.getByTestId('practice-start').click();
    for (let i=0;i<5;i++) {
      await app.waitForFunction(expected => {
        const count=document.querySelector('.practice-count > span')?.textContent;
        return Number(count)===expected && !!document.querySelector('.roman-line .cursor');
      }, i+1);
      const target=(await app.locator('.roman-line').innerText()).replace(/\s+/g,'');
      assert.ok(target.length>0);
      await app.keyboard.type(target,{delay:25});
    }
    await app.getByTestId('practice-complete').waitFor({timeout:10000});
    const data=await app.evaluate(()=>window.UchiQA.getData());
    const practiced=data.attempts.filter(a=>a.phraseId==='qa-phrase-1');
    assert.equal(practiced.length,5);
    assert.ok(practiced.every(a=>a.complete&&a.reliable));
    const session=data.sessions.find(s=>s.id===practiced[0].sessionId);
    assert.ok(session?.endedAt);assert.equal(session.phraseCount,5);
    await app.screenshot({path:path.join(output,'practice-complete.png'),fullPage:true});
  });
  await run('Backup export is available from the real settings UI',async()=>{
    await app.getByTestId('nav-settings').click();
    const downloadEvent=app.waitForEvent('download');
    await app.getByTestId('export-data').click();
    const download=await downloadEvent;
    assert.match(download.suggestedFilename(),/^uchikomi-.*\.json$/);
    await app.getByRole('button',{name:'閉じる',exact:true}).click();
  });
  await run('360px side panel renders without horizontal overflow', async () => {
    const panel = await context.newPage();
    panel.on('pageerror', error => report.browserErrors.push(error.message));
    await panel.setViewportSize({ width: 360, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sidepanel overflow');
    await panel.screenshot({ path: path.join(output, 'sidepanel-360.png'), fullPage: true });
    await panel.close();
  });
  await run('No uncaught application exceptions', async () => assert.deepEqual(report.browserErrors, []));
} catch (e) {
  report.errors.push(String(e.stack || e));
  console.error(e.message || e);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  report.completedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  await rm(temp, { recursive: true, force: true });
}
