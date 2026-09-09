'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bytecode = require('../src/bytecode');
const { parse } = require('../src/json');

const { LispObject, toRepl } = bytecode;

function unibyte(...bytes) {
  return LispObject.unibyteStr(Buffer.from(bytes));
}

// Direct port of `test_string_repl` in src/bytecode.rs
test('test_string_repl', () => {
  assert.strictEqual(toRepl(unibyte(0x00)), '"\\0"');
  assert.strictEqual(toRepl(unibyte(0x1a)), '"\\^Z"');
  assert.strictEqual(toRepl(unibyte(0x20)), '" "');
  assert.strictEqual(toRepl(unibyte(0x7f)), '"\\d"');
  assert.strictEqual(toRepl(unibyte(0xff)), '"\\377"');
});

test('unibyte repl: named escapes', () => {
  assert.strictEqual(toRepl(unibyte(7, 8, 9, 10, 11, 12, 13)), '"\\a\\b\\t\\n\\v\\f\\r"');
  assert.strictEqual(toRepl(unibyte(27)), '"\\e"');
  assert.strictEqual(toRepl(unibyte(14)), '"\\^N"');
  assert.strictEqual(toRepl(unibyte(26)), '"\\^Z"');
  assert.strictEqual(toRepl(unibyte(34)), '"\\42"');
  assert.strictEqual(toRepl(unibyte(92)), '"\\134"');
});

test('unibyte repl: short octal escape is separated from a following octal digit', () => {
  assert.strictEqual(toRepl(unibyte(0x00, 0x37)), '"\\0\\ 7"');
  assert.strictEqual(toRepl(unibyte(0x00, 0x38)), '"\\08"');
  assert.strictEqual(toRepl(unibyte(0xff, 0x37)), '"\\3777"');
});

test('multibyte string repl escapes controls but not high code points', () => {
  assert.strictEqual(toRepl(LispObject.str('a"b\\c')), '"a\\"b\\\\c"');
  assert.strictEqual(toRepl(LispObject.str('\u0001')), '"\\001"');
  assert.strictEqual(toRepl(LispObject.str('\u007f')), '"\\177"');
  assert.strictEqual(toRepl(LispObject.str('\u00e0\u4f60')), '"\u00e0\u4f60"');
});

test('other LispObject repls', () => {
  assert.strictEqual(toRepl(LispObject.symbol('vector')), 'vector');
  assert.strictEqual(toRepl(LispObject.keyword('size')), ':size');
  assert.strictEqual(toRepl(LispObject.int(-5)), '-5');
  assert.strictEqual(toRepl(LispObject.float('1.5')), '1.5');
  assert.strictEqual(toRepl(LispObject.nil()), 'nil');
  assert.strictEqual(toRepl(LispObject.t()), 't');
  assert.strictEqual(
    toRepl(LispObject.vector([LispObject.int(1), LispObject.symbol('a')])),
    '[1 a]',
  );
});

test('lispObjectFromStr', () => {
  assert.deepStrictEqual(bytecode.lispObjectFromStr('nil'), LispObject.nil());
  assert.deepStrictEqual(bytecode.lispObjectFromStr('t'), LispObject.t());
  assert.deepStrictEqual(
    bytecode.lispObjectFromStr(':json-false'),
    LispObject.keyword('json-false'),
  );
  assert.throws(() => bytecode.lispObjectFromStr('other'), /Supported LispObject: other/);
});

test('objectTypeFromStr accepts exactly the clap value set', () => {
  assert.strictEqual(bytecode.objectTypeFromStr('plist'), bytecode.ObjectType.Plist);
  assert.strictEqual(bytecode.objectTypeFromStr('alist'), bytecode.ObjectType.Alist);
  assert.strictEqual(bytecode.objectTypeFromStr('hashtable'), bytecode.ObjectType.Hashtable);
  assert.throws(() => bytecode.objectTypeFromStr('Plist'), /invalid value/);
  assert.throws(() => bytecode.objectTypeFromStr('hash-table'), /invalid value/);
});

function repl(jsonStr, options) {
  return bytecode.generateBytecodeRepl(
    parse(jsonStr),
    Object.assign(bytecode.defaultBytecodeOptions(), options || {}),
  );
}

test('README example', () => {
  assert.strictEqual(
    repl('{"objs":[{"a":1},{"a":2}]}'),
    '#[0 "\\301\\302\\300\\303D\\300\\304D\\42D\\207" [:a :objs vector 1 2] 13]',
  );
});

test('bytecode repl is always a well-formed byte-code object literal', () => {
  for (const input of ['{}', '[]', 'null', '0', '"s"', '{"a":[1,{"b":null}]}']) {
    assert.match(repl(input), /^#\[0 ".*" \[.*\] \d+\]$/s, input);
  }
});

test('constants are deduplicated and ordered by usage count', () => {
  assert.match(repl('["dup","dup","dup","x","y"]'), /\["dup" vector "x" "y"\]/);
});

test('arrays longer than 65535 elements are chunked and vconcat-ed', () => {
  const out = repl(JSON.stringify(new Array(70000).fill(0).map((_, i) => i)));
  assert.match(out, /vconcat/);
});

test('two-level constant vector engages past 63536 constants', () => {
  const out = repl(JSON.stringify(new Array(65000).fill(0).map((_, i) => 's' + i)));
  assert.match(out, /\[\[/);
});

test('lispObjectEquals compares by structure, mirroring the derived PartialEq', () => {
  const eq = bytecode.lispObjectEquals;
  assert.strictEqual(eq(LispObject.nil(), LispObject.nil()), true);
  assert.strictEqual(eq(LispObject.t(), LispObject.nil()), false);
  assert.strictEqual(eq(LispObject.symbol('a'), LispObject.symbol('a')), true);
  assert.strictEqual(eq(LispObject.symbol('a'), LispObject.keyword('a')), false);
  assert.strictEqual(eq(LispObject.int(1), LispObject.int(1)), true);
  assert.strictEqual(eq(unibyte(1, 2), unibyte(1, 2)), true);
  assert.strictEqual(eq(unibyte(1, 2), unibyte(1, 3)), false);
  assert.strictEqual(
    eq(LispObject.vector([LispObject.int(1)]), LispObject.vector([LispObject.int(1)])),
    true,
  );
  assert.strictEqual(
    eq(LispObject.vector([LispObject.int(1)]), LispObject.vector([])),
    false,
  );
});
