import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { configureChromiumDownloads, createChromiumPipeTransport, startChromiumPipe } from './chromium-pipe.mjs';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const pair = () => {
  const input = new PassThrough(), output = new PassThrough();
  return { input, output, transport: createChromiumPipeTransport(input, output) };
};

test('Chrome pipe joins fragmented UTF-8 and several NUL-framed messages in order', async () => {
  const { output, transport } = pair(), received: object[] = [];
  transport.onmessage = (message: object) => received.push(message);
  const messages = [{ id: 1, result: { text: '寿司🍣' } }, { method: 'Page.event', params: { value: 2 } }];
  const bytes = Buffer.from(messages.map(message => JSON.stringify(message) + '\0').join(''));
  // Every multibyte character and both message boundaries cross a chunk edge.
  for (const byte of bytes) output.write(Buffer.from([byte]));
  await turn();
  assert.deepEqual(received, messages);
  output.write(Buffer.from('{"id":3}\0{"id":4}\0'));
  await turn();
  assert.deepEqual(received.slice(2), [{ id: 3 }, { id: 4 }]);
  transport.close();
});

test('Chrome pipe writes JSON with one NUL terminator without damaging embedded text', () => {
  const { input, transport } = pair(), chunks: Buffer[] = [];
  input.on('data', chunk => chunks.push(chunk));
  const message = { id: 9, method: 'Runtime.evaluate', params: { expression: '寿司\0打' } };
  transport.send(message);
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.at(-1), 0);
  assert.equal(bytes.subarray(0, -1).includes(0), false);
  assert.deepEqual(JSON.parse(bytes.subarray(0, -1).toString('utf8')), message);
  transport.close();
});

test('Chrome pipe delivers final messages before one close notification and rejects later writes', async () => {
  const { output, transport } = pair(), events: unknown[] = [];
  transport.onmessage = (message: object) => events.push(message);
  const closed = new Promise<void>(resolve => { transport.onclose = () => { events.push('closed'); resolve(); }; });
  output.end(Buffer.from('{"id":1,"result":{}}\0'));
  await closed;
  transport.close();
  await turn();
  assert.deepEqual(events, [{ id: 1, result: {} }, 'closed']);
  assert.throws(() => transport.send({ id: 2 }), /pipe is closed/);
});

test('Chrome pipe reports invalid data and notifies a close callback attached after failure', async () => {
  const { output, transport } = pair();
  output.write(Buffer.from('invalid-json\0'));
  const reason = await new Promise(resolve => { transport.onclose = resolve; });
  assert.match(String(reason), /invalid JSON/);
  assert.throws(() => transport.send({ id: 1 }), /pipe is closed/);
});

test('Chrome launch failure closes the transport and owned cleanup remains idempotent', async () => {
  // Exercise spawn failure only; this does not launch a local Chrome process.
  const owned = startChromiumPipe({ executablePath: '/uchikomi-qa-nonexistent/chrome', profileDir: '/unused-qa-profile' });
  const reason = await new Promise(resolve => { owned.transport.onclose = resolve; });
  assert.match(String(reason), /Could not launch Chrome|pipe/);
  await owned.stop();
  await owned.stop();
  assert.match(owned.diagnostics().exit.error, /ENOENT/);
});

test('Download setup enables events on the root pipe, awaits ACK and restores callbacks', async () => {
  const { input, output, transport } = pair(), unrelated: unknown[] = [];
  const previousMessage = (message: object) => unrelated.push(message), previousClose = () => {};
  transport.onmessage = previousMessage; transport.onclose = previousClose;
  let settled = false;
  const setup = configureChromiumDownloads(transport, '/qa/downloads').then(() => { settled = true; });
  const command = JSON.parse(input.read().toString('utf8').slice(0, -1));
  assert.deepEqual(command, { id: 0, method: 'Browser.setDownloadBehavior', params: {
    behavior: 'allowAndName', downloadPath: '/qa/downloads', eventsEnabled: true,
  } });
  assert.equal('sessionId' in command, false);
  await turn(); assert.equal(settled, false);
  output.write(Buffer.from('{"method":"Browser.unrelated"}\0{"id":0,"result":{}}\0'));
  await setup;
  assert.deepEqual(unrelated, [{ method: 'Browser.unrelated' }]);
  assert.equal(transport.onmessage, previousMessage); assert.equal(transport.onclose, previousClose);
  transport.close();
});

test('Download setup surfaces a CDP error without stealing subsequent transport callbacks', async () => {
  const { output, transport } = pair();
  const previousMessage = () => {};
  transport.onmessage = previousMessage;
  const setup = configureChromiumDownloads(transport, '/qa/downloads');
  output.write(Buffer.from('{"id":0,"error":{"code":-32000,"message":"Not allowed"}}\0'));
  await assert.rejects(setup, /Chrome download setup failed: Not allowed/);
  assert.equal(transport.onmessage, previousMessage); assert.equal(transport.onclose, undefined);
  transport.close();
});

test('Download setup rejects early pipe closure and preserves the original close notification', async () => {
  const { output, transport } = pair();
  let closed = 0;
  const previousClose = () => { closed++; };
  transport.onclose = previousClose;
  const setup = configureChromiumDownloads(transport, '/qa/downloads');
  output.end();
  await assert.rejects(setup, /Chrome closed during download setup/);
  await turn();
  assert.equal(closed, 1); assert.equal(transport.onclose, previousClose);
});

test('Download setup has a bounded timeout and closes an unanswered pipe', async () => {
  const { transport } = pair();
  await assert.rejects(configureChromiumDownloads(transport, '/qa/downloads', { timeout: 10 }), /did not respond within 10 ms/);
  assert.equal(transport.onmessage, undefined); assert.equal(transport.onclose, undefined);
  assert.throws(() => transport.send({ id: 1 }), /pipe is closed/);
});

test('an ACK followed by EOF still reaches the close handler registered after download setup', async () => {
  const { output, transport } = pair();
  const setup = configureChromiumDownloads(transport, '/qa/downloads');
  output.write(Buffer.from('{"id":0,"result":{}}\0'));
  output.emit('end'); // Both deliveries are queued before the ACK restores the handlers.
  await setup; await turn();
  let closed = 0;
  transport.onclose = () => { closed++; };
  await turn(); await turn();
  assert.equal(closed, 1);
});

test('Chrome pipe rejects valid JSON that cannot represent a CDP message before dispatch', async () => {
  for (const value of [null, [], true, 1, 'message', {}, { id: '1' }, { method: '' }]) {
    const { output, transport } = pair(), delivered: unknown[] = [];
    transport.onmessage = (message: unknown) => delivered.push(message);
    const reason = new Promise(resolve => {
      const timeout = setTimeout(() => resolve('No close notification'), 100);
      transport.onclose = value => { clearTimeout(timeout); resolve(value); };
    });
    output.write(Buffer.from(JSON.stringify(value) + '\0'));
    const closed = await reason; transport.close();
    assert.match(String(closed), /invalid CDP/);
    assert.deepEqual(delivered, []);
  }
  const { output, transport } = pair();
  const setup = configureChromiumDownloads(transport, '/qa/downloads');
  output.write(Buffer.from('null\0'));
  await assert.rejects(setup, /invalid CDP/);
});
