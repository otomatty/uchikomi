import 'fake-indexeddb/auto';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearData, exportData, getData, getSettings, importData, savePhrase, saveSession, updateSettings } from '../src/core/db';
import { DEFAULT_SETTINGS, type Phrase, type Session } from '../src/core/types';

const nativeChannel = globalThis.BroadcastChannel;
(globalThis as any).BroadcastChannel = undefined;
after(() => { globalThis.BroadcastChannel = nativeChannel; });
beforeEach(clearData);

const at = Date.parse('2026-12-25T12:00:00+09:00');
const phrase: Phrase = { id: 'kept-word', text: '寿司', reading: 'すし', roman: 'susi', source: 'capture', confidence: 95, verified: false, capturedAt: at, lastSeenAt: at, seenCount: 2, screenshot: 'data:image/png;base64,AA==' };
const session: Session = { id: 'kept-session', startedAt: at, endedAt: at + 120000, source: 'capture', scoreType: 'total', course: 10000, mode: 'accuracy', score: 30000, phraseCount: 2, correctKeys: 10, mistakes: 1, durationMs: 120000, activity: [{ date: '2026-12-25', activeMs: 1500, keys: 11, phrases: 2 }] };

async function writeRawSettings(settings: unknown): Promise<number> {
  const open = indexedDB.open('uchikomi-v1');
  const database = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const version = database.version;
  try {
    const tx = database.transaction('settings', 'readwrite');
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    tx.objectStore('settings').put(settings, 'main');
    await done;
  } finally { database.close(); }
  return version;
}

test('fresh and previously stored settings use native Escape without changing the database schema', async () => {
  assert.equal((await getSettings()).replayShortcut, 'Escape');
  assert.equal((await getData()).settings.replayShortcut, 'Escape');
  const { replayShortcut: _, ...legacy } = DEFAULT_SETTINGS;
  assert.equal(await writeRawSettings({ ...legacy, autoRecord: false, targetScore: 35000 }), 3);
  const expected = { ...DEFAULT_SETTINGS, autoRecord: false, targetScore: 35000 };
  assert.deepEqual(await getSettings(), expected);
  assert.deepEqual((await getData()).settings, expected);
});

test('each replay choice persists and round-trips alongside scores, images and measured activity', async () => {
  await savePhrase(phrase); await saveSession(session);
  for (const replayShortcut of ['Shift+Enter', 'F2', 'Escape'] as const) {
    await updateSettings({ replayShortcut, autoRecord: false, sessionLength: 15 });
    assert.equal((await getSettings()).replayShortcut, replayShortcut);
    const original = await getData(), backup = await exportData();
    assert.equal(backup.version, 1);
    await clearData(); await importData(JSON.parse(JSON.stringify(backup)));
    assert.deepEqual(await getData(), original);
  }
});

test('an older backup without a replay choice restores Escape and retains every existing record', async () => {
  await savePhrase(phrase); await saveSession(session); await updateSettings({ replayShortcut: 'F2' });
  const original = await getData(), backup = await exportData();
  const { replayShortcut: _, ...settings } = backup.settings;
  await importData({ ...backup, settings });
  assert.deepEqual(await getData(), { ...original, settings: { ...settings, replayShortcut: 'Escape' } });
});

test('invalid replay choices reject settings writes and the entire backup before any data changes', async () => {
  await savePhrase(phrase); await saveSession(session); await updateSettings({ replayShortcut: 'Shift+Enter' });
  const original = await getData(), backup = await exportData();
  for (const replayShortcut of [null, '', 'Esc', 'escape', 'Shift + Enter', 'Ctrl+Enter', 'Shift+F2', 'F3', 1, {}, []]) {
    await assert.rejects(updateSettings({ targetScore: 99999, replayShortcut } as any), /再プレイのキー/);
    await assert.rejects(importData({ ...backup, phrases: [{ ...phrase, id: 'new-word', text: '追加されない語句' }], settings: { ...backup.settings, targetScore: 99999, replayShortcut } }), /再プレイのキー/);
    assert.deepEqual(await getData(), original);
  }
});

test('a corrupt explicitly stored shortcut is not silently treated as an allowed key', async () => {
  await writeRawSettings({ ...DEFAULT_SETTINGS, replayShortcut: 'Ctrl+Enter' });
  await assert.rejects(getSettings(), /再プレイのキー/);
  await assert.rejects(getData(), /再プレイのキー/);
  await updateSettings({ replayShortcut: 'Escape' });
  assert.equal((await getSettings()).replayShortcut, 'Escape');
});
