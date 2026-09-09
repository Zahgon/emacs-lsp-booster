'use strict';

// Port of src/lsp_message.rs
//
// The Rust structs are `#[derive(Serialize, Deserialize)]`, so deserialization
// is strict about required fields and about the declared types (notably
// `id: Option<i32>`). `parseLspRequest` reproduces that strictness, because the
// caller in app.rs uses `?` on it.

class LspMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LspMessageError';
  }
}

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `json::from_str::<LspRequest>(..)`
 * @param {string} text
 * @returns {{jsonrpc: string, id: number|null, method: string, params: unknown}}
 */
function parseLspRequest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new LspMessageError(err.message);
  }
  if (!isPlainObject(raw)) {
    throw new LspMessageError('invalid type: expected struct LspRequest');
  }

  if (typeof raw.jsonrpc !== 'string') {
    throw new LspMessageError(
      'jsonrpc' in raw ? 'invalid type: expected a string' : 'missing field `jsonrpc`',
    );
  }
  if (typeof raw.method !== 'string') {
    throw new LspMessageError(
      'method' in raw ? 'invalid type: expected a string' : 'missing field `method`',
    );
  }
  if (!('params' in raw)) {
    throw new LspMessageError('missing field `params`');
  }

  // `Option<i32>`: absent or null is None, anything else must be an i32.
  let id = null;
  if (raw.id !== undefined && raw.id !== null) {
    if (
      typeof raw.id !== 'number' ||
      !Number.isInteger(raw.id) ||
      raw.id < I32_MIN ||
      raw.id > I32_MAX
    ) {
      throw new LspMessageError('invalid type: expected i32 for field `id`');
    }
    id = raw.id;
  }

  return { jsonrpc: raw.jsonrpc, id, method: raw.method, params: raw.params };
}

/** `LspRequest::is_notification` */
function isNotification(request) {
  return request.id === null;
}

/**
 * `json::to_string(&LspResponse { .. })` -- serde emits fields in declaration
 * order: jsonrpc, id, result, error.
 */
function serializeLspResponse(resp) {
  return JSON.stringify({
    jsonrpc: resp.jsonrpc,
    id: resp.id,
    result: resp.result === undefined ? null : resp.result,
    error: resp.error === undefined ? null : resp.error,
  });
}

/** `{:?}` rendering of `Option<i32>`, used in the "Buffer full" warning. */
function debugOptionId(id) {
  return id === null ? 'None' : 'Some(' + id + ')';
}

module.exports = {
  parseLspRequest,
  isNotification,
  serializeLspResponse,
  debugOptionId,
  LspMessageError,
};
