'use strict';

// Port of `test_parse_args` in src/main.rs, plus the surrounding CLI contract.

const test = require('node:test');
const assert = require('node:assert');

const cli = require('../src/cli');
const bytecode = require('../src/bytecode');
const { LevelFilter } = require('../src/log');

test('test_parse_args', () => {
  let parsed = cli.parseArgs(['emacs-lsp-booster', 'server_cmd', 'arg1']);
  assert.deepStrictEqual(parsed.serverCmd, ['server_cmd', 'arg1']);
  assert.strictEqual(parsed.logLevelFilter(), LevelFilter.Info);

  parsed = cli.parseArgs(['emacs-lsp-booster', '--', 'server_cmd', 'arg1']);
  assert.deepStrictEqual(parsed.serverCmd, ['server_cmd', 'arg1']);

  parsed = cli.parseArgs([
    'emacs-lsp-booster', '-v',
    '--json-object-type', 'hashtable',
    '--json-null-value', ':null',
    '--json-false-value', ':json-false',
    '--', 'server_cmd', 'arg1',
  ]);
  assert.strictEqual(parsed.logLevelFilter(), LevelFilter.Debug);
  assert.deepStrictEqual(parsed.serverCmd, ['server_cmd', 'arg1']);
  assert.strictEqual(parsed.jsonObjectType, bytecode.ObjectType.Hashtable);
  assert.deepStrictEqual(parsed.jsonNullValue, bytecode.LispObject.keyword('null'));
  assert.deepStrictEqual(parsed.jsonFalseValue, bytecode.LispObject.keyword('json-false'));

  assert.match(cli.versionText(), /^emacs-lsp-booster \d+\.\d+\.\d+\n$/);
});

test('verbosity maps like clap-verbosity-flag with InfoLevel', () => {
  const level = (...flags) =>
    cli.parseArgs(['emacs-lsp-booster'].concat(flags, ['--', 'x'])).logLevelFilter();

  assert.strictEqual(level(), LevelFilter.Info);
  assert.strictEqual(level('-v'), LevelFilter.Debug);
  assert.strictEqual(level('-vv'), LevelFilter.Trace);
  assert.strictEqual(level('-vvv'), LevelFilter.Trace);
  assert.strictEqual(level('-q'), LevelFilter.Warn);
  assert.strictEqual(level('-qq'), LevelFilter.Error);
  assert.strictEqual(level('-qqq'), LevelFilter.Off);
  assert.strictEqual(level('-qqqq'), LevelFilter.Off);
  assert.strictEqual(level('--verbose'), LevelFilter.Debug);
  assert.strictEqual(level('--quiet'), LevelFilter.Warn);
  assert.strictEqual(level('-v', '-q'), LevelFilter.Info);
});

test('backward-compatible form only applies without options or `--`', () => {
  assert.deepStrictEqual(
    cli.parseArgs(['emacs-lsp-booster', 'pyright-langserver', '--stdio']).serverCmd,
    ['pyright-langserver', '--stdio'],
  );
  assert.throws(
    () => cli.parseArgs(['emacs-lsp-booster', '-v', 'server_cmd']),
    /unexpected argument/,
  );
});

test('option flags', () => {
  assert.strictEqual(cli.parseArgs(['emacs-lsp-booster', '-n', '--', 'x']).disableBytecode, true);
  assert.strictEqual(
    cli.parseArgs(['emacs-lsp-booster', '--disable-bytecode', '--', 'x']).disableBytecode,
    true,
  );
  assert.strictEqual(
    cli.parseArgs(['emacs-lsp-booster', '--json-object-type=alist', '--', 'x']).jsonObjectType,
    bytecode.ObjectType.Alist,
  );
  const clustered = cli.parseArgs(['emacs-lsp-booster', '-nv', '--', 'x']);
  assert.strictEqual(clustered.disableBytecode, true);
  assert.strictEqual(clustered.logLevelFilter(), LevelFilter.Debug);
});

test('invalid option values are rejected', () => {
  assert.throws(
    () => cli.parseArgs(['emacs-lsp-booster', '--json-object-type', 'hash-table', '--', 'x']),
    /invalid value/,
  );
  assert.throws(
    () => cli.parseArgs(['emacs-lsp-booster', '--json-null-value', 'false', '--', 'x']),
    /invalid value/,
  );
  assert.throws(() => cli.parseArgs(['emacs-lsp-booster', '--nope', '--', 'x']), /unexpected argument/);
});

test('help and version short-circuit; no args shows help', () => {
  assert.throws(
    () => cli.parseArgs(['emacs-lsp-booster', '--help']),
    (err) => err instanceof cli.CliExit && err.exitCode === 0,
  );
  assert.throws(
    () => cli.parseArgs(['emacs-lsp-booster', '-V']),
    (err) => err instanceof cli.CliExit && err.exitCode === 0,
  );
  assert.throws(
    () => cli.parseArgs(['emacs-lsp-booster']),
    (err) => err instanceof cli.CliExit && err.exitCode === 2 && err.stream === 'stderr',
  );
});

test('empty server command after `--` parses to an empty list', () => {
  assert.deepStrictEqual(cli.parseArgs(['emacs-lsp-booster', '--']).serverCmd, []);
});
