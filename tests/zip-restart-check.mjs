// Headed Linux CI. Exercise the actual "Load unpacked" folder picker:
// Chromium deliberately forgets DevTools-installed extensions at startup.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { startChromiumPipe } from './chromium-pipe.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'uchikomi-zip-restart-'));
const extension = path.join(temp, 'managed extension');
const id = 'maalmhkjpipklfhmkbkfjfnblmcchonc';
const xdotool = (...args) => promisify(execFile)('xdotool', args, { timeout: 15000 });
let processHandle, browser, cdp, page;

async function start() {
  processHandle = startChromiumPipe({ executablePath: process.env.CHROME_BIN || chromium.executablePath(), profileDir: path.join(temp, 'profile') });
  browser = await chromium.connectOverCDP(processHandle.transport, { noDefaults: true, isLocal: true });
  cdp = await browser.newBrowserCDPSession();
  return browser.contexts()[0].newPage();
}
async function close() {
  if (cdp) await cdp.send('Browser.close', {}, { timeout: 5000 }).catch(() => {});
  if (processHandle) await processHandle.stop();
  if (browser) await browser.close().catch(() => {});
}
async function waitForVersion(version) {
  let inventory;
  for (let attempt = 0; attempt < 60; attempt++) {
    inventory = (await cdp.send('Extensions.getExtensions')).extensions;
    if (inventory.some(item => item.id === id && item.enabled && item.version === version)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Unexpected extension inventory: ' + JSON.stringify(inventory));
}

try {
  await cp('dist', extension, { recursive: true });
  await writeFile(path.join(extension, 'probe.html'), '<title>ZIP upgrade fixture</title>');
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  page = await start();
  await page.goto('chrome://extensions/');
  const devMode = page.locator('#devMode');
  if (!await devMode.evaluate(toggle => toggle.checked)) await devMode.click();
  await page.locator('#loadUnpacked').click();
  await promisify(execFile)('/usr/bin/python3', ['tests/choose-extension-directory.py', extension], { timeout: 40000 });
  await waitForVersion(manifest.version);
  const probeUrl = 'chrome-extension://' + id + '/probe.html';
  await page.goto(probeUrl);
  await page.evaluate(() => localStorage.setItem('zipUpgrade', 'saved'));
  await close();

  const nextVersion = manifest.version + '.1';
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: nextVersion }));
  const next = await start();
  await waitForVersion(nextVersion);
  await next.goto(probeUrl);
  assert.deepEqual(await next.evaluate(() => [chrome.runtime.id, chrome.runtime.getManifest().version, localStorage.getItem('zipUpgrade')]),
    [id, nextVersion, 'saved']);
  console.log('Normal unpacked install picked up the new version after restart and retained origin data.');
} catch (error) {
  if (page && !page.isClosed()) console.error('Extensions page:', await page.locator('body').ariaSnapshot({ timeout: 3000 }).catch(String));
  const windows = await xdotool('search', '--onlyvisible', '--name', '.', 'getwindowname', '%@').catch(() => null);
  if (windows) console.error('Visible windows:', windows.stdout);
  console.error(processHandle?.diagnostics().stderr?.slice(-3500));
  throw error;
} finally {
  await close();
  await rm(temp, { recursive: true, force: true });
}
