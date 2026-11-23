import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('QA distinguishes received frames from accepted frames and does not bridge capture sessions', async () => {
  const source = await readFile(new URL('./capture-routing-diagnostics.js', import.meta.url), 'utf8');
  const listeners: Function[] = [];
  const offscreen = vm.createContext({
    location: { pathname: '/offscreen.html' }, performance: { timeOrigin: 0, now: () => 1 },
    chrome: { runtime: { id: 'fixture', sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: (listener: Function) => listeners.push(listener) } } },
  });
  vm.runInContext(source, offscreen);
  const background = vm.createContext({
    location: { pathname: '/background.js' }, performance: { timeOrigin: 0, now: () => 1 },
    chrome: { runtime: { id: 'fixture', getURL: (path: string) => `chrome-extension://fixture/${path}`,
      sendMessage: async (message: any) => {
        for (const listener of listeners) listener(message, { id: 'fixture' }, () => {});
        return { ok: true, ...(message.sessionId === 'first' && message.frame.sequence === 2 ? { dropped: true } : {}) };
      }, onMessage: { addListener() {} } } },
  });
  vm.runInContext(source, background);
  for (const [index, at] of [1000, 1250, 1500].entries()) await background.chrome.runtime.sendMessage({
    type: 'UCHI_OFF_CANVAS_FRAME', target: 'offscreen', sessionId: 'first', frame: { at, sequence: index + 1 },
  });
  const read = (context: vm.Context, name: string) => JSON.parse(vm.runInContext(`JSON.stringify(__uchikomiQaRouting.${name})`, context));
  assert.equal(read(offscreen, 'receivedFrameGaps').maxGap, 250);
  assert.equal(read(background, 'acceptedFrameGaps').maxGap, 500);
  assert.equal(read(background, 'acceptedFrameGaps').gaps[0].sequence, 3);
  await background.chrome.runtime.sendMessage({ type: 'UCHI_OFF_CANVAS_FRAME', target: 'offscreen',
    sessionId: 'second', frame: { at: 10000, sequence: 1 } });
  assert.equal(read(background, 'acceptedFrameGaps').maxGap, 500);
  assert.equal(read(offscreen, 'receivedFrameGaps').maxGap, 250);
  await background.chrome.runtime.sendMessage({ type: 'UCHI_OFF_CANVAS_FRAME', target: 'offscreen',
    sessionId: 'second', frame: { at: 10750, sequence: 2 } });
  assert.equal(read(background, 'acceptedFrameGaps').maxGap, 750);
  assert.equal(read(offscreen, 'receivedFrameGaps').maxGap, 750);
});
