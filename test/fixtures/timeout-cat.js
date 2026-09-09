'use strict';

// Portable stand-in for `timeout 1 cat`, which tests/app_test.rs uses as the
// echo server (macOS has no `timeout` binary). Echoes stdin to stdout, then
// exits non-zero after the given delay.
//
// The delay argument is required. Test-file discovery walks every .js under
// test/ and executes it; without an argument this must be an immediate no-op
// rather than a process that exits 124 and reads as a failing test.

const delayArg = process.argv[2];

if (delayArg !== undefined) {
  process.stdin.pipe(process.stdout);
  setTimeout(() => {
    process.exit(124);
  }, Number(delayArg));
}
