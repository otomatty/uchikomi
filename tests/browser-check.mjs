/**
 * Reproducible QA for the unpacked extension. Never uses an existing Chrome profile.
 * npm run build && node tests/browser-check.mjs
 * HEADLESS=0 CHROME_BIN=/path/to/chrome node tests/browser-check.mjs
 * Screenshots/report are internal QA artifacts, not product assets.
 */
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access, stat } from 'node:fs/promises';
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
const report = { startedAt: new Date().toISOString(), fixtureOnly: true, checks: [], errors: [], browserErrors: [], consoleErrors: [] };
let context, app, cdp;
const run = async (name, fn) => {
  try { await fn(); report.checks.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (e) { report.checks.push({ name, ok: false, error: String(e.message || e) }); throw e; }
};

try {
  await mkdir(output, { recursive: true });
  await cp(path.join(root, 'dist'), extension, { recursive: true });
  // A blank origin-owned page lets the final regression seed an actual v1 DB
  // before any production module opens it. This exists only in the temp copy.
  await writeFile(path.join(extension,'qa-empty.html'),'<!doctype html><meta charset="utf-8"><title>Database migration fixture</title>');
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
        export { buildAttempt } from ${JSON.stringify(path.join(root, 'src/core/analytics.ts'))};
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
    // Chrome's supported extension-testing API needs an explicit opt-in. Playwright
    // supplies --remote-debugging-pipe itself. This is an isolated, disposable profile.
    // https://github.com/GoogleChrome/chrome-launcher/blob/main/test/load-extension-test.ts
    args: ['--no-sandbox', '--enable-unsafe-extension-debugging'],
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  // All website requests are blocked; only the independent local fixture is served.
  const fixture = await readFile(path.join(root, 'tests/capture-fixture.html'), 'utf8');
  await context.route(/^https?:\/\//, async route => {
    if (route.request().url() === 'https://sushida.net/play.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
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
  app = await context.newPage();
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
    assert.ok((await app.locator('body').innerText()).includes('UCHIKOMI'));
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
    const game = await context.newPage();
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
    settings: { targetScore: 30000, baselineScore: 18000, targetDate: '2026-12-25', scoreType: 'total', sessionLength: 10, includeUnverified: false },
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
    const panel = await context.newPage();
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
    app=await context.newPage();await app.goto(`chrome-extension://${extensionId}/qa-empty.html`);
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
    assert.equal(version,2);assert.match(await app.locator('.goal-bottom').innerText(),/29,740/);
    await app.getByTestId('nav-growth').click();
    assert.match(await app.locator('.score-chart svg').getAttribute('aria-label'),/29740円/);
    assert.match(await app.locator('.chart-card').innerText(),/食べた金額の合計/);
    assert.equal(await app.getByRole('button',{name:'29,740円の記録を編集',exact:true}).count(),1);
    assert.equal(await app.getByRole('button',{name:'24,000円の記録を編集',exact:true}).count(),1);
    assert.doesNotMatch(await app.locator('body').innerText(),/お得|利益|profit/i);
    await app.screenshot({animations:'disabled',path:path.join(output,'database-migrated.png'),fullPage:true});
    report.databaseMigration={from:1,to:version,reloads:2,phrases:expected.phrases.length,attempts:expected.attempts.length,sessions:expected.sessions.length,total:29740,reviewTotal:15000};
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
  if (cdp) await cdp.detach().catch(() => {});
  if (context) await context.close().catch(error => report.errors.push(`Browser cleanup: ${error.message || error}`));
  report.completedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  await rm(temp, { recursive: true, force: true });
}
