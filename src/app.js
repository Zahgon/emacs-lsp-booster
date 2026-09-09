'use strict';

// Port of src/app.rs
//
// The Rust version spawns four threads (client read, client write, server read,
// server write) connected by mpsc channels, so that neither side of the pipe
// can block the other. Node's event loop gives us the same non-blocking
// property for free: each reader is a 'data' handler and each writer is a queue
// that drains with backpressure. The queues are the channels, and
// `c2sPending` is the `AtomicI32` message counter.

const { spawn } = require('node:child_process');

const { logger } = require('./log');
const { RpcReader, RpcWriter } = require('./rpcio');
const bytecode = require('./bytecode');
const jsonParser = require('./json');
const {
  parseLspRequest,
  isNotification,
  serializeLspResponse,
  debugOptionId,
} = require('./lspMessage');

const log = logger('emacs_lsp_booster::app');

const MAX_PENDING_MSG_COUNT = 128;

/** `{:?}` of a std::process::Command. */
function debugCommand(serverCmd) {
  const parts = [serverCmd.program].concat(serverCmd.args);
  return parts.map((a) => JSON.stringify(a)).join(' ');
}

/**
 * @param {NodeJS.ReadableStream} clientReader
 * @param {NodeJS.WritableStream} clientWriter
 * @param {{program: string, args: string[]}} serverCmd
 * @param {{bytecodeOptions: object|null}} options
 * @returns {Promise<{code: number|null, signal: string|null, success: boolean}>}
 */
function runAppForever(clientReader, clientWriter, serverCmd, options) {
  log.info('About to run the lsp server with command ' + debugCommand(serverCmd));
  const bytecodeOptions = options.bytecodeOptions || null;
  if (bytecodeOptions) {
    log.info(
      'Will convert server json to bytecode! bytecode options: ' +
        bytecode.formatBytecodeOptions(bytecodeOptions),
    );
  } else {
    log.info('Bytecode disabled! Will forward server json as-is.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanupFns = [];

    const runCleanup = () => {
      for (const fn of cleanupFns) {
        try {
          fn();
        } catch {
          // teardown is best-effort
        }
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      runCleanup();
      reject(err);
    };

    const succeed = (status) => {
      if (settled) return;
      settled = true;
      runCleanup();
      resolve(status);
    };

    const child = spawn(serverCmd.program, serverCmd.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    child.on('error', (err) => {
      fail(
        new Error(
          'Failed to run the lsp server with command: ' +
            debugCommand(serverCmd) +
            ': ' +
            err.message,
        ),
      );
    });

    // ---- writers -------------------------------------------------------

    const c2sPending = { count: 0 };

    const c2sWriter = new RpcWriter(child.stdin, {
      onDequeue: () => {
        c2sPending.count -= 1;
      },
      onError: (err) => {
        // EPIPE here just means the server exited first; the child 'close'
        // handler reports the real outcome.
        if (err && err.code === 'EPIPE') {
          log.debug('Client->server write: ' + err.message);
          return;
        }
        fail(new Error('Client->server write thread failed: ' + err.message));
      },
    });

    const s2cWriter = new RpcWriter(clientWriter, {
      onError: (err) => {
        if (err && err.code === 'EPIPE') {
          log.debug('Server->client write: ' + err.message);
          return;
        }
        fail(new Error('Server->client write thread failed: ' + err.message));
      },
    });

    // ---- client -> server ----------------------------------------------

    log.debug('Started client->server read thread');
    const clientRpc = new RpcReader();

    const onClientData = (chunk) => {
      try {
        const messages = clientRpc.feed(chunk);
        for (const msg of messages) {
          if (c2sPending.count >= MAX_PENDING_MSG_COUNT) {
            const lspRequest = parseLspRequest(msg);
            // only cancel when it's not notification
            if (!isNotification(lspRequest)) {
              log.warn(
                'Buffer full, rejecting request: ' +
                  lspRequest.method +
                  ' (id=' +
                  debugOptionId(lspRequest.id) +
                  ')',
              );
              s2cWriter.send(
                serializeLspResponse({
                  jsonrpc: lspRequest.jsonrpc,
                  id: lspRequest.id,
                  result: null,
                  error: {
                    code: -32803,
                    message: '[emacs-lsp-booster] Server is busy',
                  },
                }),
              );
              continue;
            }
          }

          // Counted before the send, not after: `send` may hand the message to
          // the pipe synchronously and decrement first, and the counter must
          // never dip below zero.
          c2sPending.count += 1;
          c2sWriter.send(msg);
        }
      } catch (err) {
        fail(new Error('Client->server read thread failed: ' + err.message));
      }
    };

    const onClientEnd = () => {
      log.debug('Finished client->server read thread');
      // Equivalent to dropping the mpsc Sender: the writer drains and then
      // closes the server's stdin, which is how the server learns to exit.
      c2sWriter.end();
    };

    const onClientError = (err) => {
      fail(new Error('Client->server read thread failed: ' + err.message));
    };

    clientReader.on('data', onClientData);
    clientReader.on('end', onClientEnd);
    clientReader.on('error', onClientError);

    // ---- server -> client ----------------------------------------------

    log.debug('Started server->client read thread');
    const serverRpc = new RpcReader();

    child.stdout.on('data', (chunk) => {
      let messages;
      try {
        messages = serverRpc.feed(chunk);
      } catch (err) {
        fail(new Error('Server->client read thread failed: ' + err.message));
        return;
      }
      for (const msg of messages) {
        if (bytecodeOptions) {
          let jsonVal;
          try {
            jsonVal = jsonParser.parse(msg);
          } catch (err) {
            // Matches the Rust `?`: a malformed JSON body is fatal, unlike a
            // bytecode generation failure, which falls through below.
            fail(new Error('Server->client read thread failed: ' + err.message));
            return;
          }
          let bytecodeStr = null;
          try {
            bytecodeStr = bytecode.generateBytecodeRepl(jsonVal, bytecodeOptions);
          } catch (err) {
            log.warn('Failed to convert json to bytecode: ' + err.message);
          }
          if (bytecodeStr !== null) {
            log.debug(
              'server->client: json ' +
                Buffer.byteLength(msg) +
                ' bytes; converted to bytecode, ' +
                Buffer.byteLength(bytecodeStr) +
                ' bytes',
            );
            s2cWriter.send(bytecodeStr);
            continue;
          }
        }
        log.debug('server->client: json ' + Buffer.byteLength(msg) + ' bytes; forward as-is');
        s2cWriter.send(msg);
      }
    });

    child.stdout.on('end', () => {
      log.debug('Finished server->client read thread');
    });

    // ---- teardown -------------------------------------------------------

    cleanupFns.push(() => {
      clientReader.removeListener('data', onClientData);
      clientReader.removeListener('end', onClientEnd);
      clientReader.removeListener('error', onClientError);
      if (typeof clientReader.pause === 'function') clientReader.pause();
    });

    // 'close' (not 'exit') guarantees the child's stdout has been fully
    // delivered before we report the exit status.
    child.on('close', (code, signal) => {
      const status = { code, signal, success: code === 0 };
      // Flush whatever is still queued towards the client, then report.
      s2cWriter.drained().then(
        () => succeed(status),
        () => succeed(status),
      );
    });
  });
}

module.exports = { runAppForever, MAX_PENDING_MSG_COUNT, debugCommand };
