'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { RpcReader, RpcWriter, RpcError, frame } = require('../src/rpcio');

function readAll(reader, ...chunks) {
  const out = [];
  for (const c of chunks) out.push(...reader.feed(Buffer.from(c)));
  return out;
}

test('reads a single framed message', () => {
  const r = new RpcReader();
  assert.deepStrictEqual(readAll(r, 'Content-Length: 2\r\n\r\n{}'), ['{}']);
});

test('reads messages split across arbitrary chunk boundaries', () => {
  const payload = '{"a":1}';
  const full = frame(payload).toString('utf8');
  for (let split = 1; split < full.length; split++) {
    const r = new RpcReader();
    const got = readAll(r, full.slice(0, split), full.slice(split));
    assert.deepStrictEqual(got, [payload], 'split at ' + split);
  }
});

test('reads several messages from one chunk', () => {
  const r = new RpcReader();
  const buf = Buffer.concat([frame('{"a":1}'), frame('{"b":2}'), frame('[]')]);
  assert.deepStrictEqual(r.feed(buf), ['{"a":1}', '{"b":2}', '[]']);
});

test('tolerates extra headers, and Content-Length is byte length', () => {
  const r = new RpcReader();
  const body = 'caf\u00e9';
  const buf = Buffer.concat([
    Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n', 'ascii'),
    Buffer.from('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n', 'ascii'),
    Buffer.from(body, 'utf8'),
  ]);
  assert.deepStrictEqual(r.feed(buf), [body]);
});

test('rejects malformed headers', () => {
  assert.throws(() => new RpcReader().feed(Buffer.from('garbage\r\n')), RpcError);
  assert.throws(() => new RpcReader().feed(Buffer.from('\r\n')), RpcError);
  assert.throws(() => new RpcReader().feed(Buffer.from('Content-Length: abc\r\n\r\n')), RpcError);
});

test('incomplete input yields nothing and stays pending', () => {
  const r = new RpcReader();
  assert.deepStrictEqual(r.feed(Buffer.from('Content-Length: 10\r\n\r\n{}')), []);
  assert.strictEqual(r.hasPending(), true);
});

test('frame writes the byte length, not the character length', () => {
  assert.strictEqual(frame('caf\u00e9').toString('utf8'), 'Content-Length: 5\r\n\r\ncaf\u00e9');
});

test('writer round-trips through a reader', async () => {
  const stream = new PassThrough();
  const writer = new RpcWriter(stream);
  const messages = ['{}', '{"a":1}', 'caf\u00e9'];
  for (const m of messages) writer.send(m);
  await writer.drained();
  writer.end();

  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const reader = new RpcReader();
  assert.deepStrictEqual(reader.feed(Buffer.concat(chunks)), messages);
});

test('writer reports each dequeue exactly once', async () => {
  const stream = new PassThrough();
  let dequeued = 0;
  const writer = new RpcWriter(stream, { onDequeue: () => (dequeued += 1) });
  stream.resume();
  for (let i = 0; i < 50; i++) writer.send('{"i":' + i + '}');
  await writer.drained();
  assert.strictEqual(dequeued, 50);
});
