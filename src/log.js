'use strict';

// Port of the `log` + `env_logger` usage in the Rust original.
//
// The Rust code uses `env_logger::Builder::new().filter_level(..)`, which does
// NOT consult $RUST_LOG -- the level comes purely from the -v/-q CLI flags.
// We mirror that, and we mirror env_logger's default line format:
//     [<rfc3339> <LEVEL> <target>] <message>

const LevelFilter = {
  Off: 0,
  Error: 1,
  Warn: 2,
  Info: 3,
  Debug: 4,
  Trace: 5,
};

const LEVEL_NAMES = {
  1: 'ERROR',
  2: 'WARN ',
  3: 'INFO ',
  4: 'DEBUG',
  5: 'TRACE',
};

const LEVEL_LABELS = {
  0: 'OFF',
  1: 'ERROR',
  2: 'WARN',
  3: 'INFO',
  4: 'DEBUG',
  5: 'TRACE',
};

let currentLevel = LevelFilter.Info;
let sink = (line) => {
  try {
    process.stderr.write(line);
  } catch {
    // stderr may be closed; dropping log output is preferable to crashing.
  }
};

function setLevelFilter(level) {
  currentLevel = level;
}

function getLevelFilter() {
  return currentLevel;
}

function levelFilterLabel(level) {
  return LEVEL_LABELS[level];
}

// Test hook: capture log output instead of writing to stderr.
function setSink(fn) {
  const previous = sink;
  sink = fn;
  return previous;
}

function timestamp() {
  // env_logger's default timestamp has second precision, e.g. 2024-01-06T12:00:00Z
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function emit(level, target, message) {
  if (level > currentLevel) {
    return;
  }
  sink('[' + timestamp() + ' ' + LEVEL_NAMES[level] + ' ' + target + '] ' + message + '\n');
}

/**
 * @param {string} target module path, e.g. "emacs_lsp_booster::app"
 */
function logger(target) {
  return {
    error: (msg) => emit(LevelFilter.Error, target, msg),
    warn: (msg) => emit(LevelFilter.Warn, target, msg),
    info: (msg) => emit(LevelFilter.Info, target, msg),
    debug: (msg) => emit(LevelFilter.Debug, target, msg),
    trace: (msg) => emit(LevelFilter.Trace, target, msg),
    enabled: (level) => level <= currentLevel,
  };
}

module.exports = {
  LevelFilter,
  logger,
  setLevelFilter,
  getLevelFilter,
  levelFilterLabel,
  setSink,
};
