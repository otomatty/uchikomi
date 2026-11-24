// Launch Chromium twice with the same unpacked directory and persistent profile.
// CDP-installed test extensions are removed by Chromium on the next start.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const temp = await mkdtemp(path.join(os.tmpdir(), 'uchikomi-zip-restart-'));
const extension = path.join(temp, 'managed extension');
const profile = path.join(temp, 'profile');
const id = 'maalmhkjpipklfhmkbkfjfnblmcchonc';
const launch = () => chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
});
let context;
try {
  await cp('dist', extension, { recursive: true });
  await writeFile(path.join(extension, 'probe.html'), '<title>ZIP upgrade fixture</title>');
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const probeUrl = 'chrome-extension://' + id + '/probe.html';

  context = await launch();
  const before = await context.newPage();
  await before.goto(probeUrl);
  assert.equal(await before.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  await before.evaluate(() => localStorage.setItem('zipUpgrade', 'saved'));
  await context.close();
  context = undefined;

  const nextVersion = manifest.version + '.1';
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: nextVersion }));
  context = await launch();
  const after = await context.newPage();
  await after.goto(probeUrl);
  const state = await after.evaluate(() => [chrome.runtime.id, chrome.runtime.getManifest().version, localStorage.getItem('zipUpgrade')]);
  assert.deepEqual(state, [id, nextVersion, 'saved']);
  console.log('Chromium loaded the new version from the same folder and retained origin data after restart.');
} finally {
  if (context) await context.close();
  await rm(temp, { recursive: true, force: true });
}
