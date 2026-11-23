import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

test('manual keyboard capture excludes outside focus and resumes after tab visibility changes', async t => {
  const browser = new Window({ url: 'https://sushida.net/play.html' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of ['window', 'document', 'Element', 'HTMLCanvasElement']) define(name, name === 'window' ? browser : (browser as any)[name]);
  define('__uchikomiObserver', undefined);
  const messages: any[] = [];
  let onMessage: ((message: any, sender: any, respond: (value: any) => void) => unknown) | undefined;
  define('chrome', { runtime: {
    id: 'observer-test', getManifest: () => ({ version: '1.4.0' }), async sendMessage(message: unknown) { messages.push(message); return { ok: true }; },
    onMessage: { addListener(listener: typeof onMessage) { onMessage = listener; } },
  } });
  Object.defineProperty(browser.document, 'hasFocus', { configurable: true, value: () => true });
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value: 'visible' });
  browser.document.body.innerHTML = '<canvas tabindex="0"></canvas><button>Page action</button><input><div contenteditable="true" tabindex="0">Editor</div>';
  t.after(async () => {
    onMessage?.({ type: 'UCHI_CAPTURE_DISABLE' }, { id: 'observer-test' }, () => {});
    await browser.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  });
  await import('../src/capture/content');
  const canvas = browser.document.querySelector('canvas')!;
  const button = browser.document.querySelector('button')!;
  const input = browser.document.querySelector('input')!;
  const editor = browser.document.querySelector('div')!;
  const enable = () => onMessage?.({ type: 'UCHI_CAPTURE_ENABLE', sessionId: 'game' }, { id: 'observer-test' }, () => {});
  const disable = () => onMessage?.({ type: 'UCHI_CAPTURE_DISABLE' }, { id: 'observer-test' }, () => {});
  const press = (target: any, key: string) => {
    const event = new browser.KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true });
    // This DOM fixture represents a trusted browser key; it is not a claim of
    // end-to-end user input or an event injected into the actual game.
    Object.defineProperty(event, 'isTrusted', { value: true });
    target.dispatchEvent(event);
  };
  canvas.focus(); enable();
  canvas.dispatchEvent(new browser.Event('pointerdown', { bubbles: true }));
  press(canvas, 'a');
  press(canvas, 'Tab'); button.focus(); // The browser's Tab focus transition.
  press(button, 'b');
  disable();
  assert.deepEqual(messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS').flatMap(message => message.keys.map((key: any) => key.key)), ['a']);
  assert.equal(messages.filter(message => message.type === 'UCHI_CAPTURE_GAP').length, 1);

  messages.length = 0; canvas.focus(); enable();
  press(canvas, 'c'); input.focus(); press(input, 'd');
  canvas.focus(); press(canvas, 'e'); editor.focus(); press(editor, 'f');
  disable();
  assert.deepEqual(messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS').flatMap(message => message.keys.map((key: any) => key.key)), ['c', 'e']);
  assert.equal(messages.filter(message => message.type === 'UCHI_CAPTURE_GAP').length, 2);

  messages.length = 0; canvas.focus(); enable();
  press(canvas, 'g');
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value: 'hidden' });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  press(canvas, 'h');
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value: 'visible' });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  press(canvas, 'i');
  disable();
  assert.deepEqual(messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS').flatMap(message => message.keys.map((key: any) => key.key)), ['g', 'i']);
  assert.equal(messages.filter(message => message.type === 'UCHI_CAPTURE_GAP').length, 1);
  assert.equal(messages.filter(message => message.type === 'UCHI_CANVAS_END').length, 0, 'manual tab capture is not ended through the automatic canvas protocol');

  messages.length = 0; canvas.focus(); enable();
  press(canvas, 'j');
  browser.dispatchEvent(new browser.Event('pagehide'));
  press(canvas, 'k');
  assert.deepEqual(messages.filter(message => message.type === 'UCHI_CAPTURE_KEYS').flatMap(message => message.keys.map((key: any) => key.key)), ['j']);
  assert.equal(messages.filter(message => message.type === 'UCHI_CANVAS_END').length, 0, 'navigation flushes manual keys and leaves stopping to the background');
});
