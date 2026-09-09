'use strict';

// Covers the env_logger-compatible line format and the level filter.

const test = require('node:test');
const assert = require('node:assert');

const log = require('../src/log');

function capture(level, fn) {
  const previousLevel = log.getLevelFilter();
  const lines = [];
  const previousSink = log.setSink((line) => lines.push(line));
  log.setLevelFilter(level);
  try {
    fn(log.logger('emacs_lsp_booster::test'));
  } finally {
    log.setSink(previousSink);
    log.setLevelFilter(previousLevel);
  }
  return lines;
}

test('log lines carry an rfc3339 timestamp, a padded level and the target', () => {
  const lines = capture(log.LevelFilter.Trace, (l) => l.info('hello'));
  assert.strictEqual(lines.length, 1);
  assert.match(
    lines[0],
    /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z INFO {2}emacs_lsp_booster::test\] hello\n$/,
  );
});

test('every level is emitted with its own label', () => {
  const lines = capture(log.LevelFilter.Trace, (l) => {
    l.error('e');
    l.warn('w');
    l.info('i');
    l.debug('d');
    l.trace('t');
  });
  assert.strictEqual(lines.length, 5);
  assert.match(lines[0], / ERROR /);
  assert.match(lines[1], / WARN {2}/);
  assert.match(lines[2], / INFO {2}/);
  assert.match(lines[3], / DEBUG /);
  assert.match(lines[4], / TRACE /);
});

test('the filter suppresses anything below the configured level', () => {
  const lines = capture(log.LevelFilter.Warn, (l) => {
    l.error('kept');
    l.warn('kept');
    l.info('dropped');
    l.debug('dropped');
  });
  assert.strictEqual(lines.length, 2);

  assert.strictEqual(capture(log.LevelFilter.Off, (l) => l.error('x')).length, 0);
});

test('enabled() reports what the filter will emit', () => {
  capture(log.LevelFilter.Info, (l) => {
    assert.strictEqual(l.enabled(log.LevelFilter.Error), true);
    assert.strictEqual(l.enabled(log.LevelFilter.Info), true);
    assert.strictEqual(l.enabled(log.LevelFilter.Debug), false);
  });
});

test('levelFilterLabel names each filter level', () => {
  assert.strictEqual(log.levelFilterLabel(log.LevelFilter.Off), 'OFF');
  assert.strictEqual(log.levelFilterLabel(log.LevelFilter.Error), 'ERROR');
  assert.strictEqual(log.levelFilterLabel(log.LevelFilter.Warn), 'WARN');
  assert.strictEqual(log.levelFilterLabel(log.LevelFilter.Info), 'INFO');
  assert.strictEqual(log.levelFilterLabel(log.LevelFilter.Debug), 'DEBUG');
  assert.strictEqual(log.levelFilterLabel(log.LevelFilter.Trace), 'TRACE');
});

test('getLevelFilter reports the level that was set', () => {
  const previous = log.getLevelFilter();
  log.setLevelFilter(log.LevelFilter.Debug);
  assert.strictEqual(log.getLevelFilter(), log.LevelFilter.Debug);
  log.setLevelFilter(previous);
  assert.strictEqual(log.getLevelFilter(), previous);
});
