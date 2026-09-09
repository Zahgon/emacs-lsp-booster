'use strict';

// Port of tests/app_test.rs, plus coverage for the pending-message throttle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { runAppForever, MAX_PENDING_MSG_COUNT } = require('../src/app');
const { frame, RpcReader } = require('../src/rpcio');

const FIXTURES = path.join(__dirname, 'fixtures');

const PLIST_OPTIONS = {
  objectType: 'plist',
  nullValue: { type: 'nil' },
  falseValue: { type: 'nil' },
};

function echoServer(ms) {
  return { program: process.execPath, args: [path.join(FIXTURES, 'timeout-cat.js'), String(ms)] };
}

function deafServer(ms) {
  return { program: process.execPath, args: [path.join(FIXTURES, 'deaf-server.js'), String(ms)] };
}

test('test_app_with_echo_server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elb-test-'));
  const outputPath = path.join(dir, 'output.txt');
  const outputFile = fs.createWriteStream(outputPath);

  const input = new PassThrough();
  for (let i = 0; i < 10; i++) input.write(frame('{}'));

  const status = await runAppForever(input, outputFile, echoServer(1000), {
    bytecodeOptions: PLIST_OPTIONS,
  });

  assert.strictEqual(status.success, false);

  await new Promise((resolve) => outputFile.end(resolve));
  const output = fs.readFileSync(outputPath, 'utf8');
  assert.strictEqual(Array.from(output).filter((c) => c === '#').length, 10);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('echoed messages are real bytecode and framed correctly', async () => {
  const collected = [];
  const output = new PassThrough();
  output.on('data', (c) => collected.push(c));

  const input = new PassThrough();
  input.write(frame('{"objs":[{"a":1},{"a":2}]}'));

  await runAppForever(input, output, echoServer(600), { bytecodeOptions: PLIST_OPTIONS });

  assert.deepStrictEqual(new RpcReader().feed(Buffer.concat(collected)), [
    '#[0 "\\301\\302\\300\\303D\\300\\304D\\42D\\207" [:a :objs vector 1 2] 13]',
  ]);
});

test('bytecodeOptions=null forwards server json untouched', async () => {
  const collected = [];
  const output = new PassThrough();
  output.on('data', (c) => collected.push(c));

  const input = new PassThrough();
  input.write(frame('{"a":1,"b":[1,2,3]}'));

  await runAppForever(input, output, echoServer(600), { bytecodeOptions: null });

  assert.deepStrictEqual(new RpcReader().feed(Buffer.concat(collected)), ['{"a":1,"b":[1,2,3]}']);
});

test('a busy server gets requests rejected rather than queued forever', async () => {
  const collected = [];
  const output = new PassThrough();
  output.on('data', (c) => collected.push(c));

  const input = new PassThrough();
  const filler = 'x'.repeat(8192);
  for (let i = 0; i < MAX_PENDING_MSG_COUNT * 4; i++) {
    input.write(
      frame(
        JSON.stringify({
          jsonrpc: '2.0',
          id: i,
          method: 'textDocument/completion',
          params: { filler },
        }),
      ),
    );
  }

  await runAppForever(input, output, deafServer(1500), { bytecodeOptions: null });

  const messages = new RpcReader().feed(Buffer.concat(collected));
  assert.ok(messages.length > 0, 'expected at least one rejection');
  for (const m of messages) {
    const parsed = JSON.parse(m);
    assert.strictEqual(parsed.jsonrpc, '2.0');
    assert.strictEqual(typeof parsed.id, 'number');
    assert.strictEqual(parsed.result, null);
    assert.deepStrictEqual(parsed.error, {
      code: -32803,
      message: '[emacs-lsp-booster] Server is busy',
    });
  }
});

test('notifications are never rejected, even when the server is busy', async () => {
  const collected = [];
  const output = new PassThrough();
  output.on('data', (c) => collected.push(c));

  const input = new PassThrough();
  const filler = 'x'.repeat(8192);
  for (let i = 0; i < MAX_PENDING_MSG_COUNT * 4; i++) {
    input.write(
      frame(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { filler } })),
    );
  }

  await runAppForever(input, output, deafServer(1200), { bytecodeOptions: null });

  assert.strictEqual(new RpcReader().feed(Buffer.concat(collected)).length, 0);
});

test('a missing server program is reported as a spawn failure', async () => {
  await assert.rejects(
    runAppForever(
      new PassThrough(),
      new PassThrough(),
      { program: 'definitely-not-a-real-binary-xyz', args: [] },
      { bytecodeOptions: null },
    ),
    /Failed to run the lsp server with command/,
  );
});

test('the server exit code is propagated', async () => {
  const status = await runAppForever(
    new PassThrough(),
    new PassThrough(),
    { program: process.execPath, args: ['-e', 'process.exit(3)'] },
    { bytecodeOptions: null },
  );
  assert.strictEqual(status.code, 3);
  assert.strictEqual(status.success, false);
});

test('closing the client stream closes the server stdin, letting it exit', async () => {
  const input = new PassThrough();
  input.write(frame('{"a":1}'));
  input.end();

  const collected = [];
  const output = new PassThrough();
  output.on('data', (c) => collected.push(c));

  const status = await runAppForever(input, output, { program: 'cat', args: [] }, {
    bytecodeOptions: null,
  });

  assert.strictEqual(status.code, 0);
  assert.deepStrictEqual(new RpcReader().feed(Buffer.concat(collected)), ['{"a":1}']);
});

test('a failing client stream is reported, not swallowed', async () => {
  const input = new PassThrough();
  const pending = runAppForever(input, new PassThrough(), echoServer(1500), {
    bytecodeOptions: null,
  });
  setTimeout(() => input.emit('error', new Error('client stream broke')), 50);
  await assert.rejects(pending, /Client->server read thread failed: client stream broke/);
});

test('a failing client writer is reported, not swallowed', async () => {
  const { Writable } = require('node:stream');
  const broken = new Writable({
    write(chunk, encoding, callback) {
      callback(new Error('client writer broke'));
    },
  });

  const input = new PassThrough();
  input.write(frame('{"a":1}'));

  await assert.rejects(
    runAppForever(input, broken, echoServer(1500), { bytecodeOptions: null }),
    /Server->client write thread failed: client writer broke/,
  );
});
