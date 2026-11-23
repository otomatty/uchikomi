/**
 * Reproducible QA for the unpacked extension. Never uses an existing Chrome profile.
 * npm run build && node tests/browser-check.mjs
 * Linux CI: xvfb-run -a npm run test:browser
 * The complete suite uses headed Chrome for genuine tab visibility changes.
 * HEADLESS=1 is an explicit diagnostic option; all assertions still apply.
 * CHROME_BIN=/path/to/chrome node tests/browser-check.mjs
 * Screenshots/report are internal QA artifacts, not product assets.
 */
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { configureChromiumDownloads, startChromiumPipe } from './chromium-pipe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'qa');
const temp = await mkdtemp(path.join(os.tmpdir(), 'uchikomi-qa-'));
const extension = path.join(temp, 'extension');
const headless = process.env.HEADLESS === '1';
const report = { startedAt: new Date().toISOString(), fixtureOnly: true,
  browserMode: { headless, displayProvided: !!process.env.DISPLAY, noDefaults: true, transport: 'pipe' },
  checks: [], errors: [], browserErrors: [], consoleErrors: [] };
let context, app, cdp, chromeProcess, connectedBrowser;
const newQaPage = async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  return page;
};
const run = async (name, fn) => {
  try { await fn(); report.checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (e) { report.checks.push({ name, ok: false, error: String(e.message || e) }); throw e; }
};

try {
  await mkdir(output, { recursive: true });
  await cp(path.join(root, 'dist'), extension, { recursive: true });
  // Capture counters exist only in this temporary QA copy. The packaged
  // content script and its browser/media APIs still execute normally.
  const observerFile = path.join(extension, 'content.js');
  const diagnostics = await readFile(path.join(root, 'tests/canvas-diagnostics.js'), 'utf8');
  await writeFile(observerFile, diagnostics + '\n' + await readFile(observerFile, 'utf8'));
  // A blank origin-owned page lets the final regression seed an actual v1 DB
  // before any production module opens it. This exists only in the temp copy.
  await writeFile(path.join(extension,'qa-empty.html'),'<!doctype html><meta charset="utf-8"><title>Database migration fixture</title>');
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const routingDiagnostics = await readFile(path.join(root, 'tests/capture-routing-diagnostics.js'), 'utf8');
  const offscreenDocument = await readFile(path.join(extension, 'offscreen.html'), 'utf8');
  const offscreenScript = offscreenDocument.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/)?.[1];
  assert.ok(offscreenScript, 'The production offscreen entry script is missing');
  for (const entry of [manifest.background.service_worker, offscreenScript]) {
    const file = path.resolve(extension, entry);
    assert.ok(file.startsWith(extension + path.sep), 'Diagnostics must stay in the temporary extension copy');
    await writeFile(file, routingDiagnostics + '\n' + await readFile(file, 'utf8'));
  }
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
        export { buildAttempt } from ${JSON.stringify(path.join(root, 'src/core/analytics.ts'))};
        import { detectPromptRegions } from ${JSON.stringify(path.join(root, 'src/capture/auto-region.ts'))};
        import { detectResultRegions } from ${JSON.stringify(path.join(root, 'src/capture/auto-result.ts'))};
        async function imageFrame(dataUrl) {
          // This helper is called while the extension tab is truly hidden.
          // Decode bytes directly; HTMLImageElement.decode can await rendering
          // work that a hidden document does not perform.
          const comma=dataUrl.indexOf(','), header=dataUrl.slice(0,comma), type=header.slice(5,-7);
          if(comma<0||!header.startsWith('data:')||!header.endsWith(';base64')||
            !['image/png','image/jpeg','image/webp'].includes(type))throw new Error('Invalid QA image');
          const bytes=Uint8Array.from(atob(dataUrl.slice(comma+1)),character=>character.charCodeAt(0));
          const image=await createImageBitmap(new Blob([bytes],{type}));
          try {
            const canvas=document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
            const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0);
            return ctx.getImageData(0,0,canvas.width,canvas.height);
          } finally {image.close();}
        }
        export async function detectPromptFromImage(dataUrl) { return detectPromptRegions(await imageFrame(dataUrl)); }
        export async function detectResultFromImage(dataUrl) { return detectResultRegions(await imageFrame(dataUrl)); }
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
  const profileDir = path.join(temp, 'profile'), artifactsDir = path.join(temp, 'downloads');
  await mkdir(profileDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  // launchPersistentContext enables focus emulation on every page, which keeps
  // inactive tabs visible even in headed mode. The public pipe transport and
  // noDefaults option retain Chrome's actual visibility and focus lifecycle.
  // The same local pipe supports Chrome's explicit extension-testing API.
  chromeProcess = await startChromiumPipe({
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), profileDir, headless,
  });
  // Enable events on the same root pipe Playwright will observe. A separate
  // attached CDP session would receive download events only for that session.
  await configureChromiumDownloads(chromeProcess.transport, artifactsDir);
  connectedBrowser = await chromium.connectOverCDP(chromeProcess.transport, {
    noDefaults: true, isLocal: true, artifactsDir, timeout: 30000,
  });
  context = connectedBrowser.contexts()[0];
  assert.ok(context, 'The disposable Chrome profile must expose its default context');
  // All website requests are blocked; only the independent local fixture is served.
  const fixture = await readFile(path.join(root, 'tests/capture-fixture.html'), 'utf8');
  let activeFixture = fixture;
  let canvasFixture = await readFile(path.join(root, 'tests/canvas-capture-fixture.html'), 'utf8');
  for (const kind of ['reading', 'japanese', 'roman']) {
    const png = await readFile(path.join(root, `tests/ocr-fixtures/${kind}.png`));
    canvasFixture = canvasFixture.replace(`__UCHI_${kind.toUpperCase()}_PNG__`, `data:image/png;base64,${png.toString('base64')}`);
  }
  assert.ok(!canvasFixture.includes('__UCHI_'), 'Unresolved WebGL fixture image');
  await context.route(/^https?:\/\//, async route => {
    if (route.request().url() === 'https://sushida.net/play.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: activeFixture });
    return route.abort('blockedbyclient');
  });
  context.on('weberror', event => report.browserErrors.push(event.error().message));
  context.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push({ text: message.text().slice(0, 1000), location: message.location() });
  });
  const browser = context.browser();
  assert.ok(browser, 'A Chromium browser is required for extension installation');
  report.browserVersion = browser.version();
  cdp = await browser.newBrowserCDPSession();
  let extensionId;
  await run('Explicit unpacked-extension installation and enabled status', async () => {
    // A direct install returns the ID or the actual manifest/install error. We do
    // not infer installation success from the arrival of a serviceworker event.
    const installed = await cdp.send('Extensions.loadUnpacked', { path: extension });
    extensionId = installed.id;
    assert.match(extensionId, /^[a-p]{32}$/, 'Chrome did not return a valid extension ID');
    const inventory = await cdp.send('Extensions.getExtensions');
    report.extensions = inventory.extensions;
    const loaded = inventory.extensions.find(item => item.id === extensionId);
    assert.ok(loaded, 'Installed extension is missing from Chrome extension inventory');
    assert.equal(loaded.enabled, true, 'Chrome installed the extension in a disabled state');
    assert.equal(loaded.version, manifest.version, 'Installed extension version differs from the build');
  });
  app = await newQaPage();
  await app.goto(`chrome-extension://${extensionId}/index.html`);
  await run('Extension service worker responds through its real runtime message handler', async () => {
    const reply = await app.evaluate(() => Promise.race([
      chrome.runtime.sendMessage({ type: 'UCHI_STATUS' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('UCHI_STATUS did not respond within 10 seconds')), 10000)),
    ]));
    assert.equal(reply?.ok, true, 'Background UCHI_STATUS response was not successful');
    assert.equal(reply.status?.state, 'idle', 'A fresh extension must start with an idle capture');
    report.backgroundStatus = reply.status;
    report.serviceWorkerUrls = context.serviceWorkers().map(worker => worker.url());
  });
  await app.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
  await app.addScriptTag({ url: `chrome-extension://${extensionId}/qa-harness.js` });
  await app.bringToFront();

  await run('Initial user data is empty (no synthetic records)', async () => {
    const data = await app.evaluate(() => window.UchiQA.getData());
    assert.equal(data.phrases.length, 0); assert.equal(data.attempts.length, 0); assert.equal(data.sessions.length, 0);
    assert.equal(data.settings.targetScore, 30000); assert.equal(data.settings.targetDate, '2026-12-25');
    assert.equal(data.settings.autoRecord, true, 'Automatic recording must be enabled by default');
    assert.equal(data.settings.replayShortcut, 'Escape', 'Replay must default to the unchanged game Escape key');
    assert.ok((await app.locator('body').innerText()).includes('UCHIKOMI'));
    // The original screenshot/layout fixtures are not live capture tests. Keep
    // their data unchanged; a separate WebGL check below exercises the default.
    await app.evaluate(() => window.UchiQA.updateSettings({ autoRecord: false }));
  });
  await run('Desktop layout and keyboard focus', async () => {
    assert.ok(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'desktop overflow');
    await app.keyboard.press('Tab');
    assert.ok(await app.evaluate(() => document.activeElement !== document.body), 'keyboard focus did not advance');
    await app.screenshot({ animations: 'disabled', path: path.join(output, 'desktop-empty.png'), fullPage: true });
  });
  await run('Packaged OCR worker and WASM work offline under extension CSP', async () => {
    const result = await app.evaluate(() => window.UchiQA.ocrSmoke());
    assert.equal(result.text, 'pearukku'); assert.ok(result.confidence >= 60);
    report.ocrFixture = result;
  });

  await run('Automatic prompt bounds from a full browser screenshot, including page margins', async () => {
    const game = await newQaPage();
    await game.goto('https://sushida.net/play.html');
    await game.bringToFront();
    await game.evaluate(async () => {
      await document.fonts.ready;
      window.fixture.repaint();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
    });
    report.promptFixture = await game.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const r = canvas.getBoundingClientRect();
      return { title: document.title, state: window.fixture.state, canvas: { x: r.x, y: r.y, width: r.width, height: r.height }, viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio };
    });
    // Persist the exact detector input before asserting, so failures retain the
    // fixture image, not just a screenshot of the separate extension UI page.
    const image = 'data:image/png;base64,'+(await game.screenshot({ path: path.join(output, 'prompt-fixture.png') })).toString('base64');
    const detected = await app.evaluate(dataUrl => window.UchiQA.detectPromptFromImage(dataUrl), image);
    report.promptDetection = detected;
    assert.ok(detected && detected.confidence > .8, 'independent prompt was not detected');
    const expected = await game.evaluate(() => {
      const r=document.querySelector('canvas').getBoundingClientRect();
      return {x:(r.x+150*r.width/900)/innerWidth,y:(r.y+190*r.height/560)/innerHeight,width:600*r.width/900/innerWidth,height:172*r.height/560/innerHeight};
    });
    for (const key of ['x','y','width','height']) assert.ok(Math.abs(detected.panel[key]-expected[key])<.015, 'incorrect '+key);
    assert.ok(detected.reading.y<detected.japanese.y && detected.japanese.y<detected.roman.y);
    await game.getByRole('button',{name:'空画面',exact:true}).click();
    const blank='data:image/png;base64,'+(await game.screenshot({ path: path.join(output, 'prompt-blank.png') })).toString('base64');
    report.blankPromptDetection = await app.evaluate(dataUrl => window.UchiQA.detectPromptFromImage(dataUrl), blank);
    assert.equal(report.blankPromptDetection,null);
    await game.close();
  });

  const now = Date.now();
  const imported = {
    version: 1, exportedAt: now,
    settings: { targetScore: 30000, baselineScore: 18000, targetDate: '2026-12-25', scoreType: 'total', sessionLength: 10, includeUnverified: false, autoRecord: false },
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
    // Installation opens a welcome tab, and the image fixture opens another tab.
    // Explicitly restore focus; the product intentionally pauses when focus is lost.
    await app.bringToFront();
    await app.waitForFunction(() => !document.hidden && document.hasFocus());
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
      if(i===0)await app.keyboard.type('q',{delay:25});
      await app.keyboard.type(target,{delay:25});
    }
    await app.getByTestId('practice-complete').waitFor({timeout:10000});
    const data=await app.evaluate(()=>window.UchiQA.getData());
    const practiced=data.attempts.filter(a=>a.phraseId==='qa-phrase-1');
    assert.equal(practiced.length,5);
    assert.ok(practiced.every(a=>a.complete&&a.reliable));
    const wrong=practiced.flatMap(a=>a.judgements??[]).filter(key=>!key.accepted);
    assert.equal(wrong.length,1);
    assert.equal(wrong[0].actual,'q');assert.deepEqual(wrong[0].expected,['p']);
    const session=data.sessions.find(s=>s.id===practiced[0].sessionId);
    assert.ok(session?.endedAt);assert.equal(session.phraseCount,5);
    assert.ok(Array.isArray(session.activity), 'The actual practice must persist measured daily activity');
    assert.equal(session.activity.reduce((sum, day) => sum + day.keys, 0), 41);
    assert.equal(session.activity.reduce((sum, day) => sum + day.phrases, 0), 5, 'Repeated words count toward practice volume');
    assert.ok(session.activity.reduce((sum, day) => sum + day.activeMs, 0) > 0);
    report.measuredPractice = { sessionId: session.id, activity: session.activity };
    await app.screenshot({ animations: 'disabled',path:path.join(output,'practice-complete.png'),fullPage:true});
  });
  await run('Mistake details show actual keys, correct candidates and per-key history',async()=>{
    await app.getByTestId('nav-phrases').click();
    await app.getByTestId('filter-mistakes').click();
    assert.equal(await app.getByTestId('phrase-row').count(),1);
    await app.getByRole('button',{name:'テスト用のペアルックを編集',exact:true}).click();
    await app.locator('.confusion-row').waitFor();
    assert.equal(await app.locator('.confusion-row .key-wrong').innerText(),'q');
    assert.equal(await app.locator('.confusion-row .key-correct').innerText(),'p');
    await app.locator('.key-history summary').click();
    assert.equal(await app.locator('.trace-key.rejected').count(),1);
    assert.match(await app.locator('.trace-key.rejected').getAttribute('aria-label'),/正解候補 p/);
    await app.screenshot({ animations: 'disabled',path:path.join(output,'mistake-details.png'),fullPage:true});
    await app.getByRole('button',{name:'閉じる',exact:true}).click();
  });
  await run('Repeated slow intervals filter to actual saved words in the browser UI',async()=>{
    await app.evaluate(async()=>{
      const data=await window.UchiQA.getData(),startedAt=Date.now();
      const session={id:'qa-measurements',startedAt,endedAt:startedAt+30000,source:'practice',scoreType:'total',course:10000,mode:'accuracy',phraseCount:12,correctKeys:90,mistakes:0,durationMs:30000};
      await window.UchiQA.saveSession(session);
      for(const phrase of data.phrases)for(let i=0;i<6;i++){
        const start=startedAt+i*2000;let at=start;
        const strokes=[...phrase.roman].map((key,index)=>{
          at+=phrase.roman.slice(index-1,index+1)==='kk'?320:80;
          return{key,at};
        });
        await window.UchiQA.saveAttempt(window.UchiQA.buildAttempt({phrase,strokes,startedAt:start,endedAt:at+80,sessionId:session.id,source:'practice',complete:true,reliable:true}));
      }
    });
    await app.getByTestId('filter-slow').click();
    await app.locator('.slow-pattern').first().waitFor();
    assert.equal(await app.getByTestId('phrase-row').count(),1);
    assert.match(await app.getByTestId('phrase-row').innerText(),/テスト用のペアルック/);
    assert.ok(await app.getByRole('button',{name:/^kkの語句を見る/}).count());
    await app.screenshot({ animations: 'disabled',path:path.join(output,'slow-patterns.png'),fullPage:true});
  });
  await run('An automatic score is saved once and appears in growth without manual entry',async()=>{
    const saved=await app.evaluate(async()=>{
      const startedAt=Date.now();
      const session={id:'qa-auto-score',captureId:'qa-capture',startedAt,endedAt:startedAt+120000,source:'capture',scoreType:'total',course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:120000};
      await window.UchiQA.saveSession(session);
      const score={score:29740,scoreType:'total',scoreConfidence:94,scoreObservedAt:startedAt+120000,scoreTotal:29740,scoreModeSource:'configured'};
      const first=await window.UchiQA.saveAutomaticScore(session.id,score);
      const duplicate=await window.UchiQA.saveAutomaticScore(session.id,score);
      const data=await window.UchiQA.getData();
      return{first,duplicate,sessions:data.sessions.filter(s=>s.id===session.id)};
    });
    assert.equal(saved.first,true);assert.equal(saved.duplicate,false);assert.equal(saved.sessions.length,1);
    assert.equal(saved.sessions[0].scoreSource,'ocr');assert.equal(saved.sessions[0].score,29740);assert.equal(saved.sessions[0].scoreType,'total');
    await app.getByTestId('nav-growth').click();
    await app.getByRole('button',{name:'29,740円の記録を編集',exact:true}).waitFor();
    assert.match(await app.locator('.session-score').innerText(),/合計.*自動/);
    assert.match(await app.locator('.growth-stats').innerText(),/29,740/);
    assert.match(await app.locator('.chart-card').innerText(),/食べた金額の合計/);
    assert.doesNotMatch(await app.locator('body').innerText(),/お得|利益|profit/i);
    await app.screenshot({ animations: 'disabled',path:path.join(output,'automatic-score.png'),fullPage:true});
  });
  await run('A backup larger than 30 MiB round-trips through settings into an empty database',async()=>{
    await app.bringToFront();
    const original=await app.evaluate(()=>window.UchiQA.exportData());
    // Compare every field without sending large images to Node or an assertion diff.
    const snapshot=async()=>{
      const data=await window.UchiQA.getData();
      for(const key of ['phrases','attempts','sessions'])data[key].sort((a,b)=>a.id.localeCompare(b.id));
      const json=JSON.stringify(data,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
        ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
      return {sha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''),
        phrases:data.phrases.length,attempts:data.attempts.length,sessions:data.sessions.length,
        phraseImages:data.phrases.filter(p=>p.screenshot).length,
        scoreEvidence:data.sessions.filter(s=>s.scoreEvidence).length,
        reviewEvidence:data.sessions.filter(s=>s.scoreReview?.evidence).length};
    };
    let download;
    try {
      const fixture=await app.evaluate(async()=>{
        const data=await window.UchiQA.getData(),at=Date.now();
        const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
        const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(512,512);let seed=123456789;
        for(let i=0;i<pixels.data.length;i++){
          seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
          pixels.data[i]=i%4===3?255:seed&255;
        }
        ctx.putImageData(pixels,0,0);
        const screenshot=canvas.toDataURL('image/png'),image=new Image();image.src=screenshot;await image.decode();
        if(image.naturalWidth!==512||screenshot.length>=3000000)throw new Error('Invalid backup image fixture');
        const count=Math.ceil(31*1024*1024/screenshot.length);
        for(let i=0;i<count;i++)data.phrases.push({id:`qa-backup-image-${i}`,text:`バックアップ画像 ${i}`,reading:'がぞう',roman:'gazou',
          source:'capture',confidence:100,verified:true,capturedAt:at+i,lastSeenAt:at+i,seenCount:1,screenshot});
        const scored=data.sessions.find(s=>s.id==='qa-auto-score');
        if(!scored)throw new Error('Missing automatic score fixture');
        scored.scoreEvidence=screenshot;
        data.sessions.push({id:'qa-backup-review',startedAt:at,source:'capture',scoreType:'total',course:10000,mode:'accuracy',
          phraseCount:0,correctKeys:0,mistakes:0,durationMs:0,
          scoreReview:{score:28000,scoreType:'total',confidence:60,observedAt:at,reason:'画像を確認',evidence:screenshot}});
        await window.UchiQA.importData({...data,version:1});
        return {addedImages:count,imageCharacters:screenshot.length};
      });
      const expected=await app.evaluate(snapshot);
      assert.equal(expected.phrases,original.phrases.length+fixture.addedImages);
      assert.equal(expected.attempts,original.attempts.length);assert.equal(expected.sessions,original.sessions.length+1);
      assert.ok(expected.scoreEvidence>0&&expected.reviewEvidence>0);
      await app.getByTestId('nav-settings').click();
      assert.equal(await app.locator('[role="dialog"] option[value="profit"],[role="dialog"] option[value="total"]').count(),0);
      assert.doesNotMatch(await app.getByRole('dialog').innerText(),/お得|利益|スコアの基準/);
      const downloadEvent=app.waitForEvent('download');
      await app.getByTestId('export-data').click();
      download=await downloadEvent;
      assert.match(download.suggestedFilename(),/^uchikomi-.*\.json$/);
      const file=await download.path();assert.ok(file);
      const {size}=await stat(file);assert.ok(size>30*1024*1024,'Backup must exceed the former 30 MiB limit');
      const empty=await app.evaluate(async()=>{
        await window.UchiQA.clearData();const data=await window.UchiQA.getData();
        return [data.phrases.length,data.attempts.length,data.sessions.length];
      });
      assert.deepEqual(empty,[0,0,0]);
      await app.getByTestId('import-file').setInputFiles(file);
      await app.getByRole('dialog').waitFor({state:'hidden',timeout:60000});
      await app.getByRole('status').filter({hasText:'バックアップを読み込みました'}).waitFor();
      assert.deepEqual(await app.evaluate(snapshot),expected,'Backup restore changed records, images or score evidence');
      report.backupRoundTrip={bytes:size,...fixture,...expected};
    } finally {
      // Playwright owns the download in a temporary directory; never put it in qa/.
      if(download)await download.delete();
      await app.evaluate(async value=>{await window.UchiQA.clearData();await window.UchiQA.importData(value);},original);
    }
  });
  await run('360px side panel renders without horizontal overflow', async () => {
    const panel = await newQaPage();
    await panel.setViewportSize({ width: 360, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sidepanel overflow');
    await panel.screenshot({ animations: 'disabled', path: path.join(output, 'sidepanel-360.png'), fullPage: true });
    await panel.locator('.panel-nav button').nth(1).click();
    await panel.getByTestId('filter-slow').click();
    await panel.locator('.slow-pattern').first().waitFor();
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'word analysis overflow');
    await panel.screenshot({ animations: 'disabled', path: path.join(output, 'sidepanel-analysis-360.png'), fullPage: true });
    await panel.close();
  });
  await run('An actual version-1 database upgrades totals once while retaining records and evidence',async()=>{
    const original=await app.evaluate(()=>window.UchiQA.getData());
    // Release every origin-owned connection, including Chrome's welcome tab.
    for(const page of context.pages())if(page.url().startsWith(`chrome-extension://${extensionId}/`))await page.close();
    app=await newQaPage();await app.goto(`chrome-extension://${extensionId}/qa-empty.html`);
    await app.bringToFront();
    const legacy=await app.evaluate(async original=>{
      const data=structuredClone(original),at=Date.now();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#df6948';ctx.fillRect(0,0,8,8);
      const evidence=canvas.toDataURL('image/png'),image=new Image();image.src=evidence;await image.decode();
      data.settings.scoreType='profit';data.phrases[0].screenshot=evidence;
      const scored=data.sessions.find(s=>s.id==='qa-auto-score');
      if(!scored)throw new Error('Missing pre-migration automatic score');
      Object.assign(scored,{score:19740,scoreType:'profit',scoreTotal:29740,scoreProfit:19740,scoreEvidence:evidence});
      const base={source:'capture',course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:1000};
      data.sessions.push({...base,id:'qa-old-total',startedAt:scored.startedAt-2000,endedAt:scored.startedAt-1000,score:24000,scoreTotal:24000,scoreType:'total'});
      data.sessions.push({...base,id:'qa-old-review',startedAt:at,endedAt:at+1000,scoreType:'profit',
        scoreReview:{score:5000,scoreType:'profit',confidence:65,observedAt:at,reason:'画像を確認',evidence}});
      const request=(req,label)=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`${label} did not settle`)),5000);
        req.onsuccess=()=>{clearTimeout(timer);resolve(req.result);};
        req.onerror=()=>{clearTimeout(timer);reject(req.error);};
        req.onblocked=()=>{clearTimeout(timer);reject(new Error(`${label} was blocked by an open connection`));};
      });
      await request(indexedDB.deleteDatabase('uchikomi-v1'),'Delete current database');
      const opening=indexedDB.open('uchikomi-v1',1);
      opening.onupgradeneeded=()=>{
        const db=opening.result;db.createObjectStore('phrases',{keyPath:'id'});
        const attempts=db.createObjectStore('attempts',{keyPath:'id'});attempts.createIndex('phraseId','phraseId');attempts.createIndex('sessionId','sessionId');
        db.createObjectStore('sessions',{keyPath:'id'});db.createObjectStore('settings');
      };
      const db=await request(opening,'Create legacy database');
      try{
        if(db.version!==1)throw new Error('Legacy fixture must start at database version 1');
        const tx=db.transaction(['phrases','attempts','sessions','settings'],'readwrite');
        const completed=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{tx.abort();reject(new Error('Legacy data write did not settle'));},5000);
          tx.oncomplete=()=>{clearTimeout(timer);resolve();};
          tx.onabort=tx.onerror=()=>{clearTimeout(timer);reject(tx.error??new Error('Legacy data write failed'));};
        });
        for(const name of ['phrases','attempts','sessions'])for(const row of data[name])tx.objectStore(name).put(row);
        tx.objectStore('settings').put(data.settings,'main');await completed;
      }finally{db.close();}
      return data;
    },original);
    // Expected values come from the pre-migration total snapshot, with explicit
    // known conversions for the two legacy fixtures, rather than the migrator.
    const expected=structuredClone(original);
    expected.phrases.find(p=>p.id===legacy.phrases[0].id).screenshot=legacy.phrases[0].screenshot;
    expected.sessions.find(s=>s.id==='qa-auto-score').scoreEvidence=legacy.sessions.find(s=>s.id==='qa-auto-score').scoreEvidence;
    expected.sessions.push(legacy.sessions.find(s=>s.id==='qa-old-total'));
    const review=legacy.sessions.find(s=>s.id==='qa-old-review');
    expected.sessions.push({...review,scoreType:'total',scoreReview:{...review.scoreReview,score:15000,scoreType:'total'}});
    const canonical=data=>({...data,phrases:[...data.phrases].sort((a,b)=>a.id.localeCompare(b.id)),
      attempts:[...data.attempts].sort((a,b)=>a.id.localeCompare(b.id)),sessions:[...data.sessions].sort((a,b)=>a.id.localeCompare(b.id))});
    for(let pass=0;pass<3;pass++){
      if(pass===0)await app.goto(`chrome-extension://${extensionId}/index.html`);else await app.reload();
      await app.getByTestId('app-shell').waitFor();
      await app.addScriptTag({url:`chrome-extension://${extensionId}/qa-harness.js`});
      const actual=await app.evaluate(()=>window.UchiQA.getData());
      assert.deepEqual(canonical(actual),canonical(expected),`Database migration/reload ${pass} changed a record`);
      assert.equal(actual.settings.targetScore,30000);assert.equal(actual.settings.baselineScore,18000);assert.equal(actual.settings.scoreType,'total');
      assert.ok(actual.sessions.every(s=>s.scoreType==='total'&&!('scoreProfit' in s)));
    }
    const version=await app.evaluate(()=>new Promise((resolve,reject)=>{
      const req=indexedDB.open('uchikomi-v1'),timer=setTimeout(()=>reject(new Error('Database version read timed out')),5000);
      req.onsuccess=()=>{clearTimeout(timer);const version=req.result.version;req.result.close();resolve(version);};
      req.onerror=()=>{clearTimeout(timer);reject(req.error);};
    }));
    assert.equal(version,3);assert.match(await app.locator('.goal-bottom').innerText(),/29,740/);
    await app.getByTestId('nav-growth').click();
    assert.match(await app.locator('.score-chart svg').getAttribute('aria-label'),/29740円/);
    assert.match(await app.locator('.chart-card').innerText(),/食べた金額の合計/);
    assert.equal(await app.getByRole('button',{name:'29,740円の記録を編集',exact:true}).count(),1);
    assert.equal(await app.getByRole('button',{name:'24,000円の記録を編集',exact:true}).count(),1);
    assert.doesNotMatch(await app.locator('body').innerText(),/お得|利益|profit/i);
    await app.screenshot({animations:'disabled',path:path.join(output,'database-migrated.png'),fullPage:true});
    report.databaseMigration={from:1,to:version,reloads:2,phrases:expected.phrases.length,attempts:expected.attempts.length,sessions:expected.sessions.length,total:29740,reviewTotal:15000};
  });
  await run('Duplicate keywords consolidate histories and preserve counts when the old backup is replayed', async () => {
    const before = await app.evaluate(() => window.UchiQA.getData());
    // This check exercises real Chrome IndexedDB import transactions and
    // readback. The direct version-2-to-3 upgrade is covered by Node regressions.
    const duplicateBackup = await app.evaluate(async () => {
      const data = await window.UchiQA.getData(), at = Date.now() - 10000;
      const images = ['#b9563b', '#597763'].map(color => {
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 12;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 24, 12);
        return canvas.toDataURL('image/png');
      });
      const base = { text: '統合の確認', reading: 'とうごうのかくにん', roman: 'tougounokakuninn', verified: true };
      const phrases = [
        { ...base, id: 'qa-duplicate-capture', source: 'capture', confidence: 95, verified: false, capturedAt: at, lastSeenAt: at + 1000, seenCount: 3, screenshot: images[0] },
        { ...base, id: 'qa-duplicate-manual', source: 'manual', confidence: 100, capturedAt: at + 1000, lastSeenAt: at + 2000, seenCount: 4, screenshot: images[1] },
      ];
      const session = { id: 'qa-duplicate-session', startedAt: at + 3000, endedAt: at + 9000, source: 'practice', scoreType: 'total',
        course: 10000, mode: 'accuracy', phraseCount: 2, correctKeys: 0, mistakes: 0, durationMs: 6000 };
      const attempts = phrases.map((phrase, index) => {
        const startedAt = at + 3500 + index * 2000;
        const strokes = [...phrase.roman].map((key, index) => ({ key, at: startedAt + (index + 1) * 80 }));
        return { ...window.UchiQA.buildAttempt({ phrase, strokes, startedAt, endedAt: strokes.at(-1).at + 80,
          sessionId: session.id, source: 'practice', complete: true, reliable: true }), id: `qa-duplicate-attempt-${index}` };
      });
      session.correctKeys = attempts.reduce((sum, attempt) => sum + attempt.correctKeys, 0);
      return { version: 1, settings: data.settings, phrases, attempts, sessions: [session] };
    });
    assert.ok(duplicateBackup.attempts.every(attempt => attempt.complete && attempt.reliable));
    assert.ok(duplicateBackup.phrases.every(phrase => !before.phrases.some(existing => existing.id === phrase.id || existing.text === phrase.text)),
      'The duplicate fixture must be independent of previously saved words');
    await app.evaluate(value => window.UchiQA.importData(value), duplicateBackup);
    const merged = await app.evaluate(() => window.UchiQA.getData());
    const rows = merged.phrases.filter(phrase => phrase.text === '統合の確認');
    assert.equal(rows.length, 1); const canonical = rows[0];
    assert.equal(canonical.seenCount, 7);
    assert.equal(canonical.capturedAt, duplicateBackup.phrases[0].capturedAt);
    assert.equal(canonical.lastSeenAt, duplicateBackup.phrases[1].lastSeenAt);
    const retainedImages = [...new Set([canonical.screenshot, ...(canonical.screenshots ?? [])])];
    assert.deepEqual(retainedImages.sort(), duplicateBackup.phrases.map(phrase => phrase.screenshot).sort());
    assert.equal(merged.phrases.length, before.phrases.length + 1);
    assert.equal(merged.attempts.length, before.attempts.length + 2);
    assert.equal(merged.sessions.length, before.sessions.length + 1);
    for (const attempt of duplicateBackup.attempts) {
      assert.deepEqual(merged.attempts.find(value => value.id === attempt.id), { ...attempt, phraseId: canonical.id },
        'Consolidation must preserve all judgements and intervals under the canonical keyword');
    }
    assert.deepEqual(merged.sessions.find(session => session.id === duplicateBackup.sessions[0].id), duplicateBackup.sessions[0]);
    assert.deepEqual(merged.settings, before.settings);
    for (const kind of ['phrases', 'attempts', 'sessions']) for (const existing of before[kind]) {
      assert.deepEqual(merged[kind].find(row => row.id === existing.id), existing, `Consolidation changed existing ${kind}`);
    }
    await app.getByTestId('nav-phrases').click();
    await app.getByRole('textbox', { name: 'キーワードを検索', exact: true }).fill('統合の確認');
    await app.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="phrase-row"]');
      return rows.length === 1 && rows[0].textContent.includes('統合の確認');
    }, null, { polling: 100 });
    assert.equal(await app.getByTestId('phrase-row').count(), 1);
    assert.match(await app.getByTestId('phrase-row').innerText(), /統合の確認/);
    await app.screenshot({ animations: 'disabled', path: path.join(output, 'keywords-consolidated.png'), fullPage: true });
    const ordered = data => ({ ...data, phrases: [...data.phrases].sort((a, b) => a.id.localeCompare(b.id)),
      attempts: [...data.attempts].sort((a, b) => a.id.localeCompare(b.id)), sessions: [...data.sessions].sort((a, b) => a.id.localeCompare(b.id)) });
    await app.reload(); await app.getByTestId('app-shell').waitFor();
    await app.addScriptTag({ url: `chrome-extension://${extensionId}/qa-harness.js` });
    assert.deepEqual(ordered(await app.evaluate(() => window.UchiQA.getData())), ordered(merged), 'Reload changed consolidated data');
    await app.evaluate(value => window.UchiQA.importData(value), duplicateBackup);
    assert.deepEqual(ordered(await app.evaluate(() => window.UchiQA.getData())), ordered(merged),
      'Replaying the original IDs must not add words, attempts, images or occurrence counts');
    await app.getByRole('textbox', { name: 'キーワードを検索', exact: true }).fill('統合の確認');
    await app.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="phrase-row"]');
      return rows.length === 1 && rows[0].textContent.includes('統合の確認');
    }, null, { polling: 100 });
    assert.equal(await app.getByTestId('phrase-row').count(), 1);
    report.keywordConsolidation = { scope: 'Real Chrome IndexedDB import and readback; v2-to-v3 duplicate migration is a separate Node regression',
      canonicalId: canonical.id, oldIds: duplicateBackup.phrases.map(phrase => phrase.id), keywords: 1, seenCount: 7,
      histories: 2, retainedImages: retainedImages.length, reloads: 1, oldBackupReimports: 1, existingRecordsPreserved: true };
  });
  await run('Daily training retains measured records and navigates historical days in desktop and 360px layouts', async () => {
    const fixtures = await app.evaluate(async () => {
      const dayMs = 86400000, endAt = Date.now() - 36 * dayMs;
      const dateAt = at => new Date(at + 9 * 3600000).toISOString().slice(0, 10);
      const sessions = [];
      for (let i = 0; i < 7; i++) {
        const date = dateAt(endAt - (6 - i) * dayMs), at = Date.parse(`${date}T10:00:00+09:00`);
        for (const source of ['capture', 'practice']) {
          const capture = source === 'capture', factor = i === 6 ? 1 : (i + 2) / 10;
          const activity = { date, activeMs: Math.round((capture ? 120000 : 45000) * factor),
            keys: Math.round((capture ? 1200 : 360) * factor), phrases: Math.round((capture ? 24 : 12) * factor) };
          const session = { id: `qa-daily-${source}-${date}`, startedAt: at, endedAt: at + activity.activeMs,
            source, scoreType: 'total', course: 10000, mode: 'accuracy', phraseCount: activity.phrases,
            correctKeys: activity.keys, mistakes: 0, durationMs: activity.activeMs,
            ...(i === 5 && !capture ? {} : { activity: [activity] }) };
          await window.UchiQA.saveSession(session); sessions.push(session);
        }
      }
      return { end: dateAt(endAt), previous: dateAt(endAt - dayMs), sessions };
    });
    await app.bringToFront();
    await app.getByTestId('nav-growth').click();
    const daily = app.getByTestId('daily-training');
    await daily.locator('input[type=date]').fill(fixtures.end);
    await app.waitForFunction(() => document.querySelector('[data-testid="daily-keys"]')?.textContent === '1,560打鍵');
    assert.equal(await daily.getByTestId('daily-time').innerText(), '2分45秒');
    assert.equal(await daily.getByTestId('daily-phrases').innerText(), '36語');
    assert.equal(await daily.locator('.daily-bar').count(), 7);
    assert.match(await daily.locator('.daily-breakdown').innerText(), /寿司打\s*1記録/);
    assert.match(await daily.locator('.daily-breakdown').innerText(), /UCHIKOMI 復習\s*1セット/);
    assert.match(await daily.locator('.daily-total').innerText(), /概算を含む/);
    assert.equal(await daily.getByTestId('daily-estimated').count(), 0, 'Only the historical mixed day is estimated');
    await daily.locator(`[data-day="${fixtures.end}"]`).focus();
    await app.keyboard.press('ArrowLeft');
    assert.equal(await daily.locator('input[type=date]').inputValue(), fixtures.previous);
    assert.match(await daily.getByTestId('daily-estimated').innerText(), /概算/);
    await daily.getByRole('button', { name: '30日', exact: true }).click();
    assert.equal(await daily.locator('.daily-bar').count(), 30);
    await daily.getByRole('button', { name: '90日', exact: true }).click();
    assert.equal(await daily.locator('.daily-bar').count(), 90);
    assert.equal(await daily.locator('input[type=date]').inputValue(), fixtures.previous);
    await daily.getByRole('button', { name: '次の日', exact: true }).click();
    await daily.getByRole('button', { name: '7日', exact: true }).click();
    assert.equal(await daily.locator('input[type=date]').inputValue(), fixtures.end);
    await app.screenshot({ animations: 'disabled', path: path.join(output, 'daily-training-desktop.png'), fullPage: true });
    await daily.screenshot({ animations: 'disabled', path: path.join(output, 'daily-training-card.png') });

    const panel = await newQaPage();
    try {
      await panel.setViewportSize({ width: 360, height: 900 });
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await panel.getByRole('navigation', { name: 'パネルナビゲーション' }).getByRole('button', { name: '成長', exact: true }).click();
      const small = panel.getByTestId('daily-training');
      await small.locator('input[type=date]').fill(fixtures.end);
      await panel.waitForFunction(() => document.querySelector('[data-testid="daily-keys"]')?.textContent === '1,560打鍵');
      await panel.screenshot({ animations: 'disabled', path: path.join(output, 'daily-training-360.png'), fullPage: true });
      await small.screenshot({ animations: 'disabled', path: path.join(output, 'daily-training-360-card.png') });
      await small.getByRole('button', { name: '90日', exact: true }).click();
      assert.equal(await small.locator('.daily-bar').count(), 90);
      const layout = await panel.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        cardWidth: document.querySelector('.daily-training').clientWidth, contentWidth: document.querySelector('.daily-training').scrollWidth }));
      assert.ok(layout.documentWidth <= layout.width + 1, `Daily training overflows the side panel: ${JSON.stringify(layout)}`);
      assert.ok(layout.contentWidth <= layout.cardWidth + 1, `The 90-day chart overflows its card: ${JSON.stringify(layout)}`);
      await panel.screenshot({ animations: 'disabled', path: path.join(output, 'daily-training-90-days.png'), fullPage: true });
      await small.getByRole('button', { name: '今日へ戻る', exact: true }).click();
      const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      assert.equal(await small.locator('input[type=date]').inputValue(), today);
      report.dailyTraining = { timeZone: 'Asia/Tokyo', historicalDate: fixtures.end, measuredKeys: 1560,
        measuredActiveMs: 165000, repeatedPhrases: 36, ranges: [7, 30, 90], layout };
    } finally { await panel.close(); }
    await app.bringToFront();
    await app.reload(); await app.getByTestId('app-shell').waitFor();
    await app.addScriptTag({ url: `chrome-extension://${extensionId}/qa-harness.js` });
    const saved = await app.evaluate(() => window.UchiQA.getData());
    for (const expected of fixtures.sessions) assert.deepEqual(saved.sessions.find(value => value.id === expected.id), expected,
      'Reload must preserve each measured date and the distinct legacy marker');
    const actualPractice = saved.sessions.find(session => session.id === report.measuredPractice.sessionId);
    assert.deepEqual(actualPractice.activity, report.measuredPractice.activity, 'Measured practice must survive backup round-trip, DB upgrade and reload');
  });
  await run('Live WebGL recording respects visibility and manual pause, and replay shortcuts only act on results', async () => {
    let game, panel;
    let observedTabId;
    const result = report.automaticCanvas = { preserveDrawingBuffer: false, phases: {}, diagnostics: {} };
    const send = (type, timeout = 30000) => app.evaluate(({ type, timeout }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${type} did not respond within ${timeout} ms`)), timeout);
      chrome.runtime.sendMessage({ type }).then(reply => { clearTimeout(timer); resolve(reply); }, error => { clearTimeout(timer); reject(error); });
    }), { type, timeout });
    const readStatus = async () => {
      const reply = await send('UCHI_STATUS');
      assert.equal(reply?.ok, true, 'The real background status handler failed');
      if (reply.status?.tabId) observedTabId = reply.status.tabId;
      assert.notEqual(reply.status?.state, 'error', reply.status?.message || 'Automatic capture failed');
      return reply.status;
    };
    const gameRecords = () => app.evaluate(async since => {
      const data = await window.UchiQA.getData();
      return data.sessions.filter(value => value.source === 'capture' && value.startedAt >= since).map(value => ({
        id: value.id, captureId: value.captureId, startedAt: value.startedAt, endedAt: value.endedAt,
        phraseCount: value.phraseCount, score: value.score, scoreTotal: value.scoreTotal, scoreSource: value.scoreSource,
        scoreConfidence: value.scoreConfidence, scoreObservedAt: value.scoreObservedAt, activity: value.activity,
        scoreReview: value.scoreReview ? { score: value.scoreReview.score, reason: value.scoreReview.reason,
          confidence: value.scoreReview.confidence, observedAt: value.scoreReview.observedAt,
          hasEvidence: !!value.scoreReview.evidence } : undefined,
      }));
    }, result.phases.opened?.startedAt ?? Date.now());
    const diagnose = async label => {
      const details = result.diagnostics[label] = {};
      const [routing, status] = await Promise.all([
        app.evaluate(async () => {
          const read = context => new Promise(resolve => {
            const timeout = setTimeout(() => resolve([context, { error: 'QA context did not respond within 1200 ms' }]), 1200);
            chrome.runtime.sendMessage({ type: 'UCHI_QA_ROUTING_DIAGNOSTICS', context }).then(reply => {
              clearTimeout(timeout); resolve([context, reply ?? { error: 'QA context is unavailable' }]);
            }, error => { clearTimeout(timeout); resolve([context, { error: String(error.message || error) }]); });
          });
          return Object.fromEntries(await Promise.all(['background', 'offscreen'].map(read)));
        }).catch(error => ({ error: String(error.message || error) })),
        send('UCHI_STATUS', 1500).catch(error => ({ error: String(error.message || error) })),
      ]);
      details.routing = routing; details.status = status;
      const tabId = details.status?.status?.tabId ?? observedTabId ?? await app.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://sushida.net/play.html' });
        return tabs.find(tab => tab.active)?.id ?? tabs[0]?.id;
      });
      if (tabId) details.content = await app.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'UCHI_QA_CAPTURE_DIAGNOSTICS' }), tabId)
        .catch(error => ({ error: String(error.message || error) }));
      if (game && !game.isClosed()) details.fixture = await game.evaluate(() => ({
        ready: window.canvasFixture?.ready, frames: window.canvasFixture?.frames, visible: !document.hidden,
        state: window.canvasFixture?.state, round: window.canvasFixture?.round,
        keyboardEvents: window.canvasFixture?.keyboardEvents,
        width: document.querySelector('canvas')?.width, height: document.querySelector('canvas')?.height,
        trackProcessorAvailable: typeof MediaStreamTrackProcessor === 'function',
      })).catch(error => ({ error: String(error.message || error) }));
      // A real offscreen snapshot proves that a message was accepted and its
      // JPEG decoded, even when no prompt region has been found or published.
      const snapshot = await send('UCHI_FRAME', 1500).catch(error => ({ error: String(error.message || error) }));
      details.snapshot = { ok: snapshot?.ok, error: snapshot?.error };
      if (snapshot?.ok && snapshot.frame?.dataUrl?.startsWith('data:image/jpeg;base64,')) {
        const { dataUrl, ...metadata } = snapshot.frame;
        details.snapshot = { ok: true, ...metadata, imageCharacters: dataUrl.length };
        await writeFile(path.join(output, `automatic-${label}-ingested.jpg`), Buffer.from(dataUrl.split(',')[1], 'base64'));
        details.snapshotRegions = await app.evaluate(image => window.UchiQA.detectPromptFromImage(image), dataUrl);
        details.snapshotResultRegions = await app.evaluate(image => window.UchiQA.detectResultFromImage(image), dataUrl);
      }
    };
    const poll = async (label, read, accept, timeout = 45000) => {
      const deadline = Date.now() + timeout; let last;
      do {
        last = await read(); if (accept(last)) return last;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      throw new Error(`${label} timed out; last observation: ${JSON.stringify(last)}`);
    };
    const waitRecording = label => poll(label, async () => {
      const state = await readStatus();
      if (!result.diagnostics.waiting && state.state === 'recording' && state.source === 'canvas' &&
          !state.lastFrameAt && Date.now() - state.startedAt >= 1500) await diagnose('waiting');
      return state;
    }, state => state.state === 'recording' && state.source === 'canvas' && state.lastFrameAt >= state.startedAt);
    const assertPaused = async label => {
      // Observe for longer than the content observer's discovery interval, so
      // a delayed, unwanted restart cannot pass an immediate idle assertion.
      const deadline = Date.now() + 3500;
      do {
        assert.equal((await readStatus()).state, 'idle', label);
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
    };
    try {
      await app.bringToFront();
      await app.getByTestId('nav-dashboard').click();
      panel = await newQaPage();
      await panel.setViewportSize({ width: 360, height: 900 });
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await panel.getByTestId('capture-card').waitFor();
      await app.evaluate(() => window.UchiQA.updateSettings({ autoRecord: true, replayShortcut: 'Escape' }));
      activeFixture = canvasFixture;
      game = await newQaPage();
      await game.goto('https://sushida.net/play.html');
      await game.bringToFront();
      await game.waitForFunction(() => window.canvasFixture?.ready && window.canvasFixture.frames > 2 && !document.hidden);
      result.fixture = await game.evaluate(() => ({
        title: document.title,
        contextAttributes: window.canvasFixture.contextAttributes,
        frames: window.canvasFixture.frames,
        visible: !document.hidden,
        canvasCount: document.querySelectorAll('canvas').length,
      }));
      assert.equal(result.fixture.contextAttributes.preserveDrawingBuffer, false);
      assert.equal(result.fixture.canvasCount, 1, 'Only the live WebGL surface belongs in the page');
      // No extension action, capture permission grant, start button, or UCHI_START.
      // evaluate() observes the background extension tab without activating it.
      const first = result.phases.opened = await waitRecording('Automatic canvas recording');
      assert.ok(first.sessionId && first.documentToken);
      await diagnose('opened');
      assert.equal(result.diagnostics.opened.snapshot.ok, true, 'Offscreen must have decoded a real canvas frame');
      result.phases.recognized = await poll('The new capture recognizes its first keyword', readStatus,
        state => state.sessionId === first.sessionId && state.phraseCount >= 1 && state.latestPhrase === 'ペアルック', 90000);
      result.phrase = await poll('A real OCR phrase saved to IndexedDB', () => app.evaluate(async startedAt => {
        const data = await window.UchiQA.getData();
        const phrase = data.phrases.find(p => p.source === 'capture' && p.text === 'ペアルック' && p.lastSeenAt >= startedAt);
        return phrase ? { id: phrase.id, text: phrase.text, reading: phrase.reading, roman: phrase.roman, source: phrase.source,
          confidence: phrase.confidence, seenCount: phrase.seenCount, lastSeenAt: phrase.lastSeenAt, hasImage: !!phrase.screenshot } : null;
      }, first.startedAt), phrase => !!phrase, 90000);
      assert.equal(result.phrase.reading, 'ぺあるっく'); assert.equal(result.phrase.roman, 'pearukku');
      assert.equal(result.phrase.source, 'capture'); assert.equal(result.phrase.hasImage, true);
      assert.ok(result.phrase.lastSeenAt >= first.startedAt, 'An older saved keyword cannot satisfy the live OCR check');
      const firstGame = await poll('A real captured game saved to IndexedDB', () => app.evaluate(async captureId => {
        const data = await window.UchiQA.getData();
        return data.sessions.find(session => session.captureId === captureId) ?? null;
      }, first.sessionId), session => session?.phraseCount >= 1);
      assert.equal(firstGame.source, 'capture'); assert.equal(firstGame.scoreType, 'total');
      assert.equal(firstGame.course, 10000); assert.equal(firstGame.mode, 'accuracy');
      result.phases.freshFrames = await poll('Continuing live frames', readStatus, state => state.sessionId === first.sessionId && state.lastFrameAt > first.lastFrameAt);
      await game.locator('#game').click();
      await game.keyboard.type('pe ', { delay: 100 });
      result.measuredActivity = await poll('Physical game keys persist as daily activity', () => app.evaluate(async id => {
        const data = await window.UchiQA.getData(); return data.sessions.find(session => session.id === id)?.activity ?? null;
      }, firstGame.id), activity => activity?.reduce((sum, day) => sum + day.keys, 0) === 3, 20000);
      assert.equal(result.measuredActivity.reduce((sum, day) => sum + day.phrases, 0), 1);
      assert.ok(result.measuredActivity.reduce((sum, day) => sum + day.activeMs, 0) > 0);

      await panel.waitForFunction(() => !!document.querySelector('.capture-dot.on'), null, { polling: 250, timeout: 20000 });
      result.quietIndicator = await panel.evaluate(() => {
        const dot = document.querySelector('.capture-dot.on'), region = document.querySelector('.region-symbol');
        return { animationName: getComputedStyle(dot).animationName, boxShadow: getComputedStyle(dot).boxShadow,
          regionAnimationName: region ? getComputedStyle(region).animationName : null,
          waveBars: document.querySelectorAll('.wave-bars').length,
          label: document.querySelector('.capture-heading')?.textContent, hidden: document.hidden };
      });
      assert.equal(result.quietIndicator.animationName, 'none'); assert.equal(result.quietIndicator.boxShadow, 'none');
      assert.equal(result.quietIndicator.regionAnimationName, 'none'); assert.equal(result.quietIndicator.waveBars, 0);
      assert.match(result.quietIndicator.label, /記録中/); assert.equal(result.quietIndicator.hidden, true);
      await app.waitForFunction(() => !!document.querySelector('.session-done .live-dot'), null, { polling: 250, timeout: 20000 });
      result.quietIndicator.historyAnimations = await app.evaluate(() => [...document.querySelectorAll('.session-done .live-dot')].map(dot => getComputedStyle(dot).animationName));
      assert.ok(result.quietIndicator.historyAnimations.every(name => name === 'none'));
      assert.equal(await game.evaluate(() => document.hidden), false, 'Reading extension state must not hide the game');
      await panel.screenshot({ path: path.join(output, 'automatic-recording-panel.png'), fullPage: true });
      assert.equal(await game.evaluate(() => document.hidden), false, 'Inspecting the panel must not hide the game');
      await game.screenshot({ path: path.join(output, 'automatic-webgl-fixture.png') });

      await app.bringToFront();
      await game.waitForFunction(() => document.hidden, null, { polling: 100 });
      result.phases.hidden = await poll('Hidden canvas stops recording', readStatus, state => state.state === 'idle');
      assert.equal(await app.evaluate(async () => (await window.UchiQA.getSettings()).autoRecord), true, 'Hiding a game must keep automatic recording enabled');
      const ended = await app.evaluate(async id => (await window.UchiQA.getData()).sessions.find(session => session.id === id), firstGame.id);
      assert.ok(ended?.endedAt, 'Hiding the game must finish the captured session');
      assert.ok(ended.phraseCount >= 1, 'The recognized keyword must survive automatic stop');

      await game.bringToFront();
      const visible = result.phases.visible = await waitRecording('Visible canvas automatically resumes');
      assert.notEqual(visible.sessionId, first.sessionId, 'Returning to the game must create a fresh capture');
      assert.equal((await send('UCHI_STOP'))?.ok, true);
      result.phases.paused = await poll('Manual pause stops recording', readStatus, state => state.state === 'idle');
      assert.equal(await app.evaluate(async () => (await window.UchiQA.getSettings()).autoRecord), false);
      const pausedIds = await app.evaluate(async () => (await window.UchiQA.getData()).sessions.map(session => session.id).sort());
      await app.bringToFront();
      await game.waitForFunction(() => document.hidden, null, { polling: 100 });
      await game.bringToFront();
      await assertPaused('Manual pause was lost after the game became visible');
      await game.reload();
      await game.waitForFunction(() => window.canvasFixture?.ready && window.canvasFixture.frames > 2 && !document.hidden);
      await assertPaused('Manual pause was lost after reloading the game');
      assert.deepEqual(await app.evaluate(async () => (await window.UchiQA.getData()).sessions.map(session => session.id).sort()), pausedIds,
        'A paused game must not create extra capture sessions');

      assert.equal((await send('UCHI_RESUME'))?.ok, true);
      const resumed = result.phases.resumed = await waitRecording('Explicit resume restarts the visible canvas');
      assert.notEqual(resumed.sessionId, visible.sessionId);
      assert.equal(await app.evaluate(async () => (await window.UchiQA.getSettings()).autoRecord), true);
      assert.equal(await game.evaluate(() => document.hidden), false);
      result.openedWithoutCaptureAction = true;
      result.manualPauseSurvivedVisibilityAndReload = true;

      // Real key operations reach the production content/background/offscreen
      // path. Only fixture rendering and settings persistence are controlled;
      // no replay request or product message listener is invoked by the test.
      const replay = result.replay = { fixtureOnly: true, cases: {}, nativeEscapeUnchanged: false };
      const fixtureState = () => game.evaluate(() => ({ state: window.canvasFixture.state,
        round: window.canvasFixture.round, frames: window.canvasFixture.frames,
        keyboardEvents: window.canvasFixture.keyboardEvents, visible: !document.hidden }));
      const escapeEvents = state => state.keyboardEvents.filter(event => event.key === 'Escape');
      const setShortcut = async shortcut => {
        const saved = await app.evaluate(async value => {
          // This is the same public settings notification emitted by the UI.
          // Using the hidden app keeps the active capture alive while settings
          // propagation is tested, instead of refreshing the content script.
          await window.UchiQA.updateSettings({ replayShortcut: value });
          const reply = await chrome.runtime.sendMessage({ type: 'UCHI_REPLAY_SETTINGS_CHANGED' });
          return { reply, shortcut: (await window.UchiQA.getSettings()).replayShortcut };
        }, shortcut);
        assert.equal(saved.reply?.ok, true, 'Replay settings notification must reach the content script');
        assert.equal(saved.shortcut, shortcut);
        assert.equal((await fixtureState()).visible, true, 'Changing replay settings must not hide the game');
      };
      const playing = (label, captureId, previousId) => poll(label, readStatus, state =>
        state.state === 'recording' && state.source === 'canvas' && state.sessionId === captureId &&
        state.activeSessionId && state.activeSessionId !== previousId && state.scoreState === 'watching');
      const noReplay = async (label, key, expectedState) => {
        const before = await fixtureState(), sessionBefore = (await readStatus()).activeSessionId;
        assert.equal(before.state, expectedState);
        await game.keyboard.press(key);
        // Allow the actual runtime roundtrip to reject the action, so the
        // assertion cannot pass merely because its asynchronous reply is late.
        await game.waitForTimeout(1200);
        const after = await fixtureState();
        assert.equal(after.state, before.state, `${label}: the fixture changed screens`);
        assert.equal(after.round, before.round, `${label}: an unintended replay occurred`);
        assert.deepEqual(escapeEvents(after), escapeEvents(before), `${label}: an Escape was synthesized`);
        assert.equal((await readStatus()).activeSessionId, sessionBefore, `${label}: a new game was created`);
        return { key, screen: after.state, round: after.round, noSyntheticEscape: true };
      };
      const savedResult = async (label, gameId) => {
        const shownAt = Date.now();
        const shown = await game.evaluate(() => window.canvasFixture.showResult());
        const saved = await poll(`${label}: result total saved through live OCR`, readStatus, state =>
          state.activeSessionId === gameId && state.scoreState === 'saved' &&
          state.latestScore?.sessionId === gameId && state.latestScore.score === 29740, 90000);
        const confirmationLatencyMs = Date.now() - shownAt;
        const persisted = await app.evaluate(async id => (await window.UchiQA.getData()).sessions.find(value => value.id === id), gameId);
        assert.equal(persisted?.score, 29740); assert.equal(persisted.scoreTotal, 29740);
        assert.equal(persisted.scoreType, 'total'); assert.equal(persisted.scoreSource, 'ocr');
        await poll(`${label}: fresh result frames after score persistence`, readStatus,
          state => state.activeSessionId === gameId && state.lastFrameAt > saved.lastFrameAt);
        return { round: shown.round, sessionId: gameId, score: persisted.score, scoreSource: persisted.scoreSource,
          confirmationLatencyMs };
      };
      const replayWith = async (label, key, expectedTrusted, previous) => {
        const before = await fixtureState(); assert.equal(before.state, 'result');
        const previousEscapeCount = escapeEvents(before).length;
        await game.keyboard.press(key);
        const after = await poll(`${label}: one Escape completes a fixture replay`, fixtureState, state =>
          state.round === before.round + 1 && state.state === 'prompt' &&
          escapeEvents(state).slice(previousEscapeCount).some(event => event.type === 'keyup'), 15000);
        const events = escapeEvents(after).slice(previousEscapeCount);
        assert.equal(events.filter(event => event.type === 'keydown').length, 1, `${label}: duplicate Escape keydown`);
        assert.equal(events.filter(event => event.type === 'keyup').length, 1, `${label}: duplicate Escape keyup`);
        assert.ok(events.every(event => event.trusted === expectedTrusted), `${label}: wrong trusted/synthetic event path`);
        assert.ok(events.every(event => event.code === 'Escape'), `${label}: Escape code was not forwarded`);
        const next = await playing(`${label}: a new captured session begins on the next prompt`, previous.sessionId, previous.activeSessionId);
        assert.notEqual(next.activeSessionId, previous.activeSessionId);
        assert.equal(next.sessionId, previous.sessionId, 'Replay must keep the same ongoing canvas capture');
        return { key, fromRound: before.round, toRound: after.round,
          fromSession: previous.activeSessionId, toSession: next.activeSessionId, events, next };
      };

      let current = await playing('The resumed capture observes a real prompt before replay testing', resumed.sessionId);
      await game.locator('#game').click();
      const resultImage = await game.evaluate(() => window.canvasFixture.resultImage());
      await writeFile(path.join(output, 'replay-result-source.png'), Buffer.from(resultImage.split(',')[1], 'base64'));
      replay.resultRegions = await app.evaluate(image => window.UchiQA.detectResultFromImage(image), resultImage);
      assert.ok(replay.resultRegions?.confidence >= .9, 'The independent receipt must pass the production region detector');

      await setShortcut('Shift+Enter');
      replay.cases.shiftDuringPlay = await noReplay('Shift+Enter during a prompt', 'Shift+Enter', 'prompt');
      replay.cases.shiftResult = await savedResult('Shift+Enter', current.activeSessionId);
      await game.screenshot({ path: path.join(output, 'replay-result-webgl.png') });
      replay.cases.shiftReplay = await replayWith('Dynamic Shift+Enter mapping', 'Shift+Enter', false, current);
      current = replay.cases.shiftReplay.next;

      // Exercise the actual settings form as well as dynamic propagation. Its
      // focus change intentionally stops capture, then a reload tests that the
      // new content script obtains F2 from persisted settings on discovery.
      await app.bringToFront();
      await game.waitForFunction(() => document.hidden, null, { polling: 100 });
      await poll('Settings UI hides and stops the game capture', readStatus, state => state.state === 'idle');
      await app.getByTestId('nav-settings').click();
      const settingsDialog = app.getByRole('dialog'), shortcutSelect = settingsDialog.getByTestId('replay-shortcut');
      assert.deepEqual(await shortcutSelect.locator('option').evaluateAll(options => options.map(option => option.value)),
        ['Escape', 'Shift+Enter', 'F2']);
      assert.equal(await shortcutSelect.inputValue(), 'Shift+Enter');
      await shortcutSelect.selectOption('F2');
      await settingsDialog.getByRole('button', { name: '保存する', exact: true }).click();
      await settingsDialog.waitFor({ state: 'hidden' });
      assert.equal(await app.evaluate(async () => (await window.UchiQA.getSettings()).replayShortcut), 'F2');
      await game.reload(); await game.bringToFront();
      await game.waitForFunction(() => window.canvasFixture?.ready && window.canvasFixture.frames > 2 && !document.hidden);
      const reloaded = await waitRecording('Reloaded game automatically captures with persisted F2');
      assert.notEqual(reloaded.sessionId, current.sessionId);
      current = await playing('Reloaded game observes its first prompt', reloaded.sessionId);
      await game.locator('#game').click();
      replay.cases.f2DuringPlay = await noReplay('F2 during a prompt', 'F2', 'prompt');
      replay.cases.f2Result = await savedResult('F2 after reload', current.activeSessionId);
      replay.cases.previousShortcut = await noReplay('Old Shift+Enter mapping after selecting F2', 'Shift+Enter', 'result');
      replay.cases.f2Replay = await replayWith('Persisted F2 mapping', 'F2', false, current);
      current = replay.cases.f2Replay.next;

      await setShortcut('Escape');
      replay.cases.nativeResult = await savedResult('Unchanged native Escape', current.activeSessionId);
      replay.cases.nativeReplay = await replayWith('Unchanged native Escape', 'Escape', true, current);
      replay.nativeEscapeUnchanged = true;
      replay.customMappingUpdatedWithoutReload = true;
      replay.f2SettingSurvivedReload = true;
      await diagnose('completed');
      assert.equal(result.diagnostics.completed.routing.offscreen?.canvasBlobs?.calls, 0,
        'Hidden offscreen OCR must receive encoded images without an asynchronous canvas.toBlob handoff');
    } catch (error) {
      await diagnose('failure').catch(diagnosticError => { result.diagnosticError = String(diagnosticError.message || diagnosticError); });
      result.failureStatus = await send('UCHI_STATUS').catch(e => ({ error: String(e.message || e) }));
      result.recordsAtFailure = await gameRecords().catch(e => ({ error: String(e.message || e) }));
      if (game && !game.isClosed()) await game.screenshot({ path: path.join(output, 'automatic-webgl-failure.png'), timeout: 5000 }).catch(() => {});
      throw error;
    } finally {
      // Cleanup uses the public pause handler, never a test hook in the product.
      await send('UCHI_STOP').catch(error => report.errors.push(`Automatic capture cleanup: ${error.message || error}`));
      result.recordsAfterStop = await gameRecords().catch(e => ({ error: String(e.message || e) }));
      if (game && !game.isClosed()) await game.close();
      if (panel && !panel.isClosed()) await panel.close();
      activeFixture = fixture;
    }
  });
  await run('No uncaught application exceptions', async () => assert.deepEqual(report.browserErrors, []));
} catch (e) {
  report.errors.push(String(e.stack || e));
  console.error(e.message || e);
  if (cdp) {
    try { report.extensionsAtFailure = (await cdp.send('Extensions.getExtensions')).extensions; }
    catch (diagnosticError) { report.extensionDiagnosticError = String(diagnosticError.message || diagnosticError); }
    try { report.targetsAtFailure = (await cdp.send('Target.getTargets')).targetInfos; }
    catch (diagnosticError) { report.targetDiagnosticError = String(diagnosticError.message || diagnosticError); }
  }
  if (context) report.openPagesAtFailure = context.pages().map(page => page.url());
  if (app && !app.isClosed()) {
    await app.screenshot({ animations: 'disabled', path: path.join(output, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (cdp) await cdp.send('Browser.close', {}, { timeout: 5000 }).catch(() => {});
  if (connectedBrowser) await connectedBrowser.close().catch(() => {});
  if (chromeProcess) {
    await chromeProcess.stop().catch(error => {
      report.errors.push(`Browser cleanup: ${error.message || error}`); process.exitCode = 1;
    });
    report.chromeProcess = chromeProcess.diagnostics();
  }
  report.completedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  await rm(temp, { recursive: true, force: true });
}
