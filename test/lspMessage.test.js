'use strict';

// Port of the `mod test` in src/lsp_message.rs

const test = require('node:test');
const assert = require('node:assert');

const {
  parseLspRequest,
  isNotification,
  serializeLspResponse,
  LspMessageError,
} = require('../src/lspMessage');

test('test_lsp_request', () => {
  const jsonStr = `{
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "xxx": 123
            }
        }`;
  const req = parseLspRequest(jsonStr);
  assert.strictEqual(req.jsonrpc, '2.0');
  assert.strictEqual(req.id, 1);
  assert.strictEqual(req.method, 'initialize');
  assert.strictEqual(isNotification(req), false);
});

test('test_lsp_request_notification', () => {
  const jsonStr = `{
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }`;
  const req = parseLspRequest(jsonStr);
  assert.strictEqual(req.id, null);
  assert.strictEqual(req.method, 'initialized');
  assert.strictEqual(isNotification(req), true);
});

test('test_lsp_response_serialization', () => {
  const respStr = serializeLspResponse({
    jsonrpc: '2.0',
    id: 1,
    result: null,
    error: { code: 123, message: 'asdf' },
  });
  assert.strictEqual(
    respStr,
    '{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":123,"message":"asdf"}}',
  );
});

test('required fields are enforced like serde', () => {
  assert.throws(
    () => parseLspRequest('{"id":1,"method":"m","params":{}}'),
    /missing field `jsonrpc`/,
  );
  assert.throws(() => parseLspRequest('{"jsonrpc":"2.0","params":{}}'), /missing field `method`/);
  assert.throws(() => parseLspRequest('{"jsonrpc":"2.0","method":"m"}'), /missing field `params`/);
  assert.throws(() => parseLspRequest('not json'), LspMessageError);
});

test('id must be an i32, matching Option<i32>', () => {
  assert.strictEqual(
    parseLspRequest('{"jsonrpc":"2.0","id":null,"method":"m","params":{}}').id,
    null,
  );
  assert.throws(
    () => parseLspRequest('{"jsonrpc":"2.0","id":"abc","method":"m","params":{}}'),
    /expected i32/,
  );
  assert.throws(
    () => parseLspRequest('{"jsonrpc":"2.0","id":2147483648,"method":"m","params":{}}'),
    /expected i32/,
  );
});
