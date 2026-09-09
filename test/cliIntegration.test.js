'use strict';

// End-to-end tests that drive the real executable: exit codes, stream routing,
// and a full framed proxy session.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { RpcReader, frame } = require('../src/rpcio');

const BIN = path.join(__dirname, '..', 'bin', 'emacs-lsp-booster.js');

function run(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN].concat(args), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

test('--version goes to stdout with exit 0', async () => {
  const r = await run(['--version']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout.toString('utf8'), /^emacs-lsp-booster \d+\.\d+\.\d+\n$/);
});

test('--help goes to stdout with exit 0', async () => {
  const r = await run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout.toString('utf8'), /^Usage: emacs-lsp-booster/);
  assert.strictEqual(r.stderr, '');
});

test('no arguments prints help to stderr with exit 2', async () => {
  const r = await run([]);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.stdout.length, 0);
  assert.match(r.stderr, /^Usage: emacs-lsp-booster/);
});

test('invalid options exit 2 on stderr', async () => {
  const argsets = [
    ['--nope', '--', 'cat'],
    ['-Z', '--', 'cat'],
    ['--json-object-type', 'hash-table', '--', 'cat'],
    ['--json-null-value', 'false', '--', 'cat'],
    ['-v', 'cat'],
  ];
  for (const args of argsets) {
    const r = await run(args);
    assert.strictEqual(r.code, 2, 'args: ' + args.join(' '));
    assert.strictEqual(r.stdout.length, 0, 'args: ' + args.join(' '));
  }
});

test('a missing server command exits 1', async () => {
  assert.strictEqual((await run(['--'])).code, 1);
});

test('a nonexistent server program exits 1 on stderr', async () => {
  const r = await run(['--', 'definitely-not-a-real-binary-xyz']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stdout.length, 0);
  assert.match(r.stderr, /Failed to run the lsp server/);
});

test('the server exit code is propagated', async () => {
  assert.strictEqual((await run(['--', 'sh', '-c', 'exit 3'])).code, 3);
  assert.strictEqual((await run(['--', 'sh', '-c', 'exit 0'])).code, 0);
  assert.strictEqual((await run(['sh', '-c', 'exit 7'])).code, 7);
});

test('proxies a framed session and converts responses to bytecode', async () => {
  const input = Buffer.concat([frame('{"objs":[{"a":1},{"a":2}]}'), frame('{"b":[1,2,3]}')]);
  const r = await run(['--', 'cat'], input);

  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(new RpcReader().feed(r.stdout), [
    "#[0 \"\\301\\302\\300\\303D\\300\\304D\\42D\\207\" [:a :objs vector 1 2] 13]",
    "#[0 \"\\300\\301\\302\\303\\304#D\\207\" [:b vector 1 2 3] 13]",
  ]);
});

test('--disable-bytecode forwards json unchanged', async () => {
  const r = await run(['--disable-bytecode', '--', 'cat'], frame('{"a":1,"b":[1,2,3]}'));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(new RpcReader().feed(r.stdout), ['{"a":1,"b":[1,2,3]}']);
});

test('--json-object-type selects the lisp object representation', async () => {
  const alist = await run(['--json-object-type', 'alist', '--', 'cat'], frame('{"a":1}'));
  assert.deepStrictEqual(new RpcReader().feed(alist.stdout), ["#[0 \"\\300\\301BC\\207\" [a 1] 10]"]);

  const hash = await run(['--json-object-type', 'hashtable', '--', 'cat'], frame('{"a":1}'));
  assert.match(new RpcReader().feed(hash.stdout)[0], /make-hash-table/);
});

test('logging goes to stderr and never pollutes stdout', async () => {
  const r = await run(['-v', '--', 'cat'], frame('{"a":1}'));
  assert.strictEqual(r.code, 0);
  assert.match(r.stderr, /emacs_lsp_booster/);
  assert.match(r.stderr, /converted to bytecode/);
  assert.match(r.stdout.toString('utf8'), /^Content-Length: \d+\r\n\r\n#\[0 /);
});

test('-qqq silences the informational log lines', async () => {
  const r = await run(['-qqq', '--', 'cat'], frame('{"a":1}'));
  assert.strictEqual(r.stderr, '');
});
