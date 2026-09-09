#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

function releaseStdin() {
  // Setting exitCode (rather than calling process.exit) lets buffered stdout
  // writes flush; pausing stdin lets the event loop drain so node exits.
  try {
    const stdin = process.stdin;
    if (stdin && typeof stdin.pause === 'function') {
      stdin.pause();
    }
  } catch {
    // stdin may be unavailable (e.g. closed fd 0); nothing to release.
  }
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
    releaseStdin();
  },
  (err) => {
    process.stderr.write('Error: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exitCode = 1;
    releaseStdin();
  },
);
