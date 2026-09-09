'use strict';

// Port of src/rpcio.rs
//
// The Rust original does blocking reads on a BufRead. Node has no blocking
// stream reads, so `RpcReader` is fed chunks and yields whole messages; the
// framing rules (and the error cases) are identical.

const { logger } = require('./log');

const log = logger('emacs_lsp_booster::rpcio');

const EMPTY = Buffer.alloc(0);
const LF = 0x0a;

class RpcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RpcError';
  }
}

function parseUsize(s) {
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/** Serialize one message with its `Content-Length` header. */
function frame(content) {
  // Rust writes `content.len()`, i.e. the UTF-8 byte length.
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Incremental reader for `Content-Length`-framed JSON-RPC messages.
 *
 * Mirrors `rpc_read`: header lines until a bare CRLF (with a Content-Length
 * already seen), then exactly that many bytes of body.
 */
class RpcReader {
  constructor() {
    this.buf = EMPTY;
    this.contentLen = null;
    this.inBody = false;
  }

  /**
   * @param {Buffer} chunk
   * @returns {string[]} complete messages decoded from the stream so far
   */
  feed(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      const msg = this.next();
      if (msg === null) break;
      out.push(msg);
    }
    return out;
  }

  next() {
    for (;;) {
      if (this.inBody) {
        if (this.buf.length < this.contentLen) return null;
        const body = this.buf.subarray(0, this.contentLen);
        this.buf = this.buf.subarray(this.contentLen);
        this.contentLen = null;
        this.inBody = false;
        return body.toString('utf8');
      }

      const nl = this.buf.indexOf(LF);
      if (nl < 0) return null;
      // `read_line` keeps the trailing newline.
      const line = this.buf.subarray(0, nl + 1).toString('utf8');
      this.buf = this.buf.subarray(nl + 1);

      if (line === '\r\n' && this.contentLen !== null) {
        this.inBody = true;
        continue;
      }

      const trimmed = line.trim();
      const sep = trimmed.indexOf(': ');
      if (sep < 0) {
        throw new RpcError('Invalid header format');
      }
      const key = trimmed.slice(0, sep);
      const value = trimmed.slice(sep + 2);
      log.trace('Header: [' + JSON.stringify(key) + ', ' + JSON.stringify(value) + ']');
      if (key === 'Content-Length') {
        const parsed = parseUsize(value);
        if (parsed === null) {
          throw new RpcError('invalid digit found in string: ' + value);
        }
        this.contentLen = parsed;
      }
    }
  }

  /** True when a partial message is buffered (i.e. the stream ended mid-frame). */
  hasPending() {
    return this.buf.length > 0 || this.inBody;
  }
}

/**
 * Writes framed messages to a stream, one at a time, honouring backpressure.
 *
 * This plays the role of `process_channel_to_writer` plus the mpsc channel: the
 * queue is the channel, and `onDequeue` is the counter decrement the Rust code
 * performs as it pulls each message off.
 */
class RpcWriter {
  /**
   * @param {NodeJS.WritableStream} stream
   * @param {{onDequeue?: () => void, onError?: (err: Error) => void}} [handlers]
   */
  constructor(stream, handlers) {
    const h = handlers || {};
    this.stream = stream;
    this.onDequeue = h.onDequeue || null;
    this.onError = h.onError || null;
    this.queue = [];
    this.pumping = false;
    this.ended = false;
    this.closed = false;
    this.errored = false;
    this.drainWaiters = [];

    this.stream.on('error', (err) => {
      this.errored = true;
      this.queue.length = 0;
      this.releaseDrainWaiters();
      if (this.onError) this.onError(err);
    });
  }

  send(msg) {
    if (this.errored || this.closed) return;
    this.queue.push(msg);
    this.pump();
  }

  pump() {
    if (this.pumping || this.errored) return;
    this.pumping = true;
    for (;;) {
      if (this.queue.length === 0) {
        this.pumping = false;
        this.releaseDrainWaiters();
        if (this.ended) this.finish();
        return;
      }
      const msg = this.queue.shift();
      if (this.onDequeue) this.onDequeue();
      const ok = this.stream.write(frame(msg));
      if (!ok) {
        this.stream.once('drain', () => {
          this.pumping = false;
          this.pump();
        });
        return;
      }
    }
  }

  releaseDrainWaiters() {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves once every queued message has been handed to the stream. */
  drained() {
    if (this.queue.length === 0 && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /**
   * Flush the queue, then close the stream. This is what dropping the mpsc
   * Sender does in the Rust version: the writer thread's `iter()` completes and
   * the BufWriter (owning the pipe) is dropped, closing it.
   */
  end() {
    if (this.ended) return;
    this.ended = true;
    if (!this.pumping && this.queue.length === 0) {
      this.finish();
    } else {
      this.pump();
    }
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.stream.end === 'function') {
      try {
        this.stream.end();
      } catch {
        // Stream already torn down; nothing useful to do.
      }
    }
  }
}

module.exports = { RpcReader, RpcWriter, RpcError, frame };
