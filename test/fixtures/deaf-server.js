'use strict';

// A server that never reads its stdin, so the pipe towards it fills up and the
// booster's pending-message counter climbs past MAX_PENDING_MSG_COUNT. Used to
// exercise the "Server is busy" rejection path.
//
// The lifetime argument is required; see the note in timeout-cat.js.

const lifetimeArg = process.argv[2];

if (lifetimeArg !== undefined) {
  setTimeout(() => process.exit(0), Number(lifetimeArg));
}
