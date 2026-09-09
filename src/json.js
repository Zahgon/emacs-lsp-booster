'use strict';

// The value model the bytecode compiler consumes.
//
// Server messages arrive as JSON text and are handed to the compiler as a
// tagged tree, so the compiler can branch on the value kind without
// re-inspecting the text.
//
// The text is scanned here rather than handed to JSON.parse, because three
// properties of the reference's value model are carried by the literal and are
// destroyed by JavaScript's single numeric type:
//
//   * whether a number is an integer or a float (serde_json keeps `1` and `1.0`
//     apart; `Number` does not),
//   * the width an integer is carried at (i64/u64, so values above 2^53 survive
//     intact),
//   * the order object members are visited in (serde_json collects them into a
//     BTreeMap, so iteration is sorted by key, not by document order).

class JsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonError';
  }
}

const NULL = Object.freeze({ t: 'null' });
const TRUE = Object.freeze({ t: 'bool', v: true });
const FALSE = Object.freeze({ t: 'bool', v: false });

// Integers are carried as a Number while they are exactly representable and as
// a BigInt beyond that, so i64 values round-trip without rounding.
const EXACT_INT_LIMIT = Number.MAX_SAFE_INTEGER;
const I64_MIN = -(2n ** 63n);
const U64_MAX = 2n ** 64n - 1n;

const Json = {
  null: () => NULL,
  bool: (v) => (v ? TRUE : FALSE),
  int: (v) => ({ t: 'int', v: narrowInt(typeof v === 'bigint' ? v : BigInt(v)) }),
  float: (v) => ({ t: 'float', v }),
  str: (v) => ({ t: 'str', v }),
  arr: (v) => ({ t: 'arr', v }),
  obj: (entries) => ({ t: 'obj', v: sortEntries(entries) }),
};

function narrowInt(big) {
  return big <= BigInt(EXACT_INT_LIMIT) && big >= BigInt(-EXACT_INT_LIMIT)
    ? Number(big)
    : big;
}

/**
 * Compare two object keys the way Rust orders `String`: lexicographically by
 * UTF-8 bytes. JavaScript's own `<` compares UTF-16 code units, which puts
 * U+E000..U+FFFF after astral characters instead of before them.
 */
function compareUtf8(a, b) {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Apply BTreeMap semantics to a member list: later keys win, iteration is sorted. */
function sortEntries(entries) {
  const map = new Map();
  for (const [key, value] of entries) map.set(key, value);
  const out = Array.from(map, ([key, value]) => [key, value]);
  out.sort((x, y) => compareUtf8(x[0], y[0]));
  return out;
}

function wrap(value) {
  if (value === null) return NULL;
  switch (typeof value) {
    case 'boolean':
      return Json.bool(value);
    case 'bigint':
      return Json.int(value);
    case 'number':
      return Number.isInteger(value) ? Json.int(value) : Json.float(value);
    case 'string':
      return Json.str(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return Json.arr(value.map(wrap));
  }
  const entries = [];
  for (const key of Object.keys(value)) {
    entries.push([key, wrap(value[key])]);
  }
  return Json.obj(entries);
}

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Scanner {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }

  error(msg) {
    return new JsonError(msg + ' at position ' + this.i);
  }

  ws() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  expect(ch) {
    if (this.s[this.i] !== ch) throw this.error("expected '" + ch + "'");
    this.i++;
  }

  literal(word, value) {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return value;
    }
    throw this.error('invalid literal');
  }

  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) throw this.error('unexpected end of input');
    switch (c) {
      case '{': return this.object();
      case '[': return this.array();
      case '"': return Json.str(this.string());
      case 't': return this.literal('true', TRUE);
      case 'f': return this.literal('false', FALSE);
      case 'n': return this.literal('null', NULL);
      default: return this.number();
    }
  }

  object() {
    this.expect('{');
    const entries = [];
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return Json.obj(entries);
    }
    for (;;) {
      this.ws();
      const key = this.string();
      this.ws();
      this.expect(':');
      entries.push([key, this.value()]);
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        return Json.obj(entries);
      }
      throw this.error("expected ',' or '}'");
    }
  }

  array() {
    this.expect('[');
    const items = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return Json.arr(items);
    }
    for (;;) {
      items.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return Json.arr(items);
      }
      throw this.error("expected ',' or ']'");
    }
  }

  string() {
    this.expect('"');
    const s = this.s;
    const start = this.i;
    let out = '';
    let chunk = start;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) throw this.error('unterminated string');
      if (c === '"') {
        out += s.slice(chunk, this.i);
        this.i++;
        return out;
      }
      if (c !== '\\') {
        this.i++;
        continue;
      }
      out += s.slice(chunk, this.i);
      this.i++;
      const e = s[this.i];
      if (e === 'u') {
        const hex = s.slice(this.i + 1, this.i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error('invalid \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        this.i += 5;
      } else if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
        out += ESCAPES[e];
        this.i++;
      } else {
        throw this.error('invalid escape');
      }
      chunk = this.i;
    }
  }

  /**
   * Reads a number, keeping the distinction the literal makes.
   *
   * A literal with no fraction and no exponent is an integer, and is carried at
   * i64/u64 width. serde_json has no wider integer, so a literal beyond u64
   * falls back to a float - which is why a 20-digit integer renders in
   * exponential form.
   */
  number() {
    const s = this.s;
    const start = this.i;
    if (s[this.i] === '-') this.i++;
    while (this.i < s.length && s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    let isFloat = false;
    if (s[this.i] === '.') {
      isFloat = true;
      this.i++;
      while (this.i < s.length && s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    }
    if (s[this.i] === 'e' || s[this.i] === 'E') {
      isFloat = true;
      this.i++;
      if (s[this.i] === '+' || s[this.i] === '-') this.i++;
      while (this.i < s.length && s[this.i] >= '0' && s[this.i] <= '9') this.i++;
    }
    const text = s.slice(start, this.i);
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(text)) {
      this.i = start;
      throw this.error('invalid number');
    }
    if (isFloat) return Json.float(Number(text));
    const big = BigInt(text);
    if (big > U64_MAX || big < I64_MIN) return Json.float(Number(text));
    return { t: 'int', v: narrowInt(big) };
  }
}

/**
 * Parse a JSON document into the tagged representation described above.
 * @param {string} text
 */
function parse(text) {
  const scanner = new Scanner(text);
  const value = scanner.value();
  scanner.ws();
  if (scanner.i < text.length) throw scanner.error('trailing characters');
  return value;
}

/**
 * Render a float exactly as the reference does.
 *
 * The reference prints an f64 with Rust's shortest round-trip formatter, which
 * chooses between positional and exponential notation on the position of the
 * decimal point rather than on the magnitude thresholds JavaScript uses. With
 * `kk` the position of the decimal point relative to the shortest digit string,
 * the notation is positional for `-5 < kk <= 16` and exponential otherwise, and
 * an exponential exponent carries no `+` and no padding.
 */
function formatFloat(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';

  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);

  // toExponential() with no argument yields the shortest digit string that
  // reads back as `abs` - the same digits Rust's formatter selects.
  const [mantissa, expText] = abs.toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exp10 = Number(expText);
  const olength = digits.length;
  const kk = exp10 + 1;
  const trailingZeros = exp10 - olength + 1;

  if (trailingZeros >= 0 && kk <= 16) {
    return sign + digits + '0'.repeat(trailingZeros) + '.0';
  }
  if (kk > 0 && kk <= 16) {
    return sign + digits.slice(0, kk) + '.' + digits.slice(kk);
  }
  if (kk > -5 && kk <= 0) {
    return sign + '0.' + '0'.repeat(-kk) + digits;
  }
  const body = olength === 1 ? digits : digits[0] + '.' + digits.slice(1);
  return sign + body + 'e' + exp10;
}

/** Convert the tagged representation back to plain JS values (tests/debugging). */
function toPlain(value) {
  switch (value.t) {
    case 'null':
      return null;
    case 'bool':
      return value.v;
    case 'int':
      return value.v;
    case 'float':
      return value.v;
    case 'str':
      return value.v;
    case 'arr':
      return value.v.map(toPlain);
    case 'obj': {
      const out = {};
      for (const pair of value.v) out[pair[0]] = toPlain(pair[1]);
      return out;
    }
    default:
      throw new JsonError('unknown value tag ' + value.t);
  }
}

module.exports = { parse, Json, JsonError, compareUtf8, formatFloat, toPlain };
