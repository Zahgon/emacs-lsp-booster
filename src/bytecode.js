'use strict';

// Port of src/bytecode.rs

const { formatFloat } = require('./json');

// ---------------------------------------------------------------------------
// LispObject
// ---------------------------------------------------------------------------

const NIL = Object.freeze({ type: 'nil' });
const T = Object.freeze({ type: 't' });

const LispObject = {
  symbol: (value) => ({ type: 'symbol', value }),
  keyword: (value) => ({ type: 'keyword', value }),
  /** @param {Buffer|Uint8Array|number[]} value */
  unibyteStr: (value) => ({ type: 'unibyteStr', value }),
  str: (value) => ({ type: 'str', value }),
  /** @param {number|string} value */
  // Kept as handed over: integers past 2^53 arrive as BigInt so i64 values
  // render with their exact digits rather than a rounded approximation.
  int: (value) => ({ type: 'int', value }),
  /** @param {string} value float kept as its text form, for Eq/Ord */
  float: (value) => ({ type: 'float', value }),
  nil: () => NIL,
  t: () => T,
  vector: (value) => ({ type: 'vector', value }),
};

/** `impl FromStr for LispObject` */
function lispObjectFromStr(s) {
  if (s === 'nil') return NIL;
  if (s === 't') return T;
  if (s.startsWith(':')) return LispObject.keyword(s.slice(1));
  throw new Error('Supported LispObject: ' + s);
}

function lispObjectEquals(a, b) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'nil':
    case 't':
      return true;
    case 'unibyteStr':
      return Buffer.from(a.value).equals(Buffer.from(b.value));
    case 'vector':
      return (
        a.value.length === b.value.length &&
        a.value.every((x, i) => lispObjectEquals(x, b.value[i]))
      );
    default:
      return a.value === b.value;
  }
}

/** Stable identity used to deduplicate constants (stands in for Rust's Eq/Ord). */
function constantKey(obj) {
  switch (obj.type) {
    case 'symbol':
      return 'y' + obj.value;
    case 'keyword':
      return 'k' + obj.value;
    case 'str':
      return 's' + obj.value;
    case 'unibyteStr':
      return 'u' + Buffer.from(obj.value).toString('latin1');
    case 'int':
      return 'i' + obj.value;
    case 'float':
      return 'f' + obj.value;
    case 'nil':
      return 'n';
    case 't':
      return 't';
    case 'vector':
      return 'v[' + obj.value.map(constantKey).join('\u0000') + ']';
    default:
      throw new Error('unknown LispObject type ' + obj.type);
  }
}

function strToRepl(s) {
  let result = '"';
  // Iterate by code point, matching Rust's `s.chars()`.
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') {
      result += '\\' + ch;
    } else if (cp < 32 || cp === 127) {
      // not printable.
      // NOTE: cannot use escape for c in 128..=255, otherwise the string would
      // become unibyte.
      result += '\\' + cp.toString(8).padStart(3, '0');
    } else {
      result += ch;
    }
  }
  return result + '"';
}

function unibyteStrToRepl(bytes) {
  let result = '"';
  let lastOctEscapeNotFull = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    let octEscapeNotFull = false;
    // Arm order matches the Rust `match`: the specific byte arms win over the
    // 8..=26 control-character range and the octal range below them.
    if (c === 7) result += '\\a';
    else if (c === 8) result += '\\b';
    else if (c === 9) result += '\\t';
    else if (c === 10) result += '\\n';
    else if (c === 11) result += '\\v';
    else if (c === 12) result += '\\f';
    else if (c === 13) result += '\\r';
    else if (c === 127) result += '\\d';
    else if (c === 27) result += '\\e';
    else if (c >= 8 && c <= 26) {
      // \^@ \^A \^B ... \^Z
      result += '\\^' + String.fromCharCode(c + 64);
    } else if (c <= 7 || (c >= 27 && c <= 31) || c >= 128 || c === 34 || c === 92) {
      // oct, for unprintable and '"' and '\\'
      const octS = '\\' + c.toString(8);
      if (octS.length < 4) octEscapeNotFull = true;
      result += octS;
    } else {
      // printable
      // https://www.gnu.org/software/emacs/manual/html_node/elisp/Non_002dASCII-in-Strings.html
      if (lastOctEscapeNotFull && c >= 0x30 && c <= 0x37) {
        result += '\\ ';
      }
      result += String.fromCharCode(c);
    }
    lastOctEscapeNotFull = octEscapeNotFull;
  }
  return result + '"';
}

function toRepl(obj) {
  switch (obj.type) {
    case 'symbol':
      return obj.value;
    case 'keyword':
      return ':' + obj.value;
    case 'str':
      return strToRepl(obj.value);
    case 'unibyteStr':
      return unibyteStrToRepl(obj.value);
    case 'int':
      return obj.value.toString();
    case 'float':
      return obj.value;
    case 'nil':
      return 'nil';
    case 't':
      return 't';
    case 'vector': {
      const parts = new Array(obj.value.length);
      for (let i = 0; i < obj.value.length; i++) parts[i] = toRepl(obj.value[i]);
      return '[' + parts.join(' ') + ']';
    }
    default:
      throw new Error('unknown LispObject type ' + obj.type);
  }
}

// ---------------------------------------------------------------------------
// Constant vector layout
// ---------------------------------------------------------------------------

// to support constants more than 65536 elements:
// - for first 63536 slots, use it as normal
// - in 63536-64536, put numbers 0-1000, for indexing
// - for last 1000 slots (64536-65536), use two-level vector, 1000*1000, each is
//   a 1000-element vector

// cv: constant vector
const CV_TWO_LEVEL_VECTOR_SIZE = 1000;
const CV_NORMAL_SLOT_COUNT = (1 << 16) - CV_TWO_LEVEL_VECTOR_SIZE * 2;
const CV_TWO_LEVEL_IDX_BEGIN = CV_NORMAL_SLOT_COUNT;
const CV_TWO_LEVEL_DATA_BEGIN = CV_NORMAL_SLOT_COUNT + CV_TWO_LEVEL_VECTOR_SIZE;

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

const Op = {
  PushConstant: 0, // support more than u16, will expand to multiple ops
  Call: 1,
  StackRef: 2,
  List: 3,
  Discard: 4,
  ASet: 5,
  Add1: 6,
  Cons: 7,
  Return: 8,
};

function getStackDelta(op, arg) {
  switch (op) {
    case Op.PushConstant:
      return 1;
    case Op.Call:
      return -(arg + 1) + 1;
    case Op.StackRef:
      return 1;
    case Op.List:
      return -arg + 1;
    case Op.Discard:
      return -1;
    case Op.ASet:
      return -3 + 1;
    case Op.Add1:
      return 0;
    case Op.Cons:
      return -2 + 1;
    case Op.Return:
      return -1;
    default:
      throw new Error('unknown op ' + op);
  }
}

/** Growable byte buffer. */
class ByteBuf {
  constructor(capacity = 4096) {
    this.buf = Buffer.allocUnsafe(capacity);
    this.len = 0;
  }

  reserve(n) {
    const need = this.len + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  push(b) {
    this.reserve(1);
    this.buf[this.len++] = b;
  }

  push2(a, b) {
    this.reserve(2);
    this.buf[this.len++] = a;
    this.buf[this.len++] = b;
  }

  push3(a, b, c) {
    this.reserve(3);
    this.buf[this.len++] = a;
    this.buf[this.len++] = b;
    this.buf[this.len++] = c;
  }

  toBuffer() {
    return this.buf.subarray(0, this.len);
  }
}

function emitCode(out, op, arg) {
  switch (op) {
    case Op.PushConstant:
      if (arg < 64) {
        out.push(192 + arg);
      } else if (arg < CV_NORMAL_SLOT_COUNT) {
        out.push3(129, arg & 0xff, arg >> 8);
      } else if (
        arg <
        CV_NORMAL_SLOT_COUNT + CV_TWO_LEVEL_VECTOR_SIZE * CV_TWO_LEVEL_VECTOR_SIZE
      ) {
        const twoLevelI = Math.floor(
          (arg - CV_NORMAL_SLOT_COUNT) / CV_TWO_LEVEL_VECTOR_SIZE,
        );
        const twoLevelJ = (arg - CV_NORMAL_SLOT_COUNT) % CV_TWO_LEVEL_VECTOR_SIZE;

        // get vector
        const indexForI = twoLevelI + CV_TWO_LEVEL_DATA_BEGIN;
        out.push3(129, indexForI & 0xff, indexForI >> 8);
        // get index
        const indexForJ = twoLevelJ + CV_TWO_LEVEL_IDX_BEGIN;
        out.push3(129, indexForJ & 0xff, indexForJ >> 8);
        // aref
        out.push(72);
      } else {
        throw new Error('Too many constants! ' + arg);
      }
      return;
    case Op.Call:
      if (arg <= 5) out.push(32 + arg);
      else if (arg < 1 << 8) out.push2(32 + 6, arg);
      else out.push3(32 + 7, arg & 0xff, arg >> 8);
      return;
    case Op.StackRef:
      if (arg >= 1 && arg <= 4) out.push(arg);
      else throw new Error('StackRef(' + arg + ') is not implemented');
      return;
    case Op.List:
      if (arg === 0) throw new Error('List(0) is unreachable');
      else if (arg <= 4) out.push(66 + arg);
      else out.push2(175, arg);
      return;
    case Op.Discard:
      out.push(136);
      return;
    case Op.ASet:
      out.push(73);
      return;
    case Op.Add1:
      out.push(84);
      return;
    case Op.Cons:
      out.push(66);
      return;
    case Op.Return:
      out.push(135);
      return;
    default:
      throw new Error('unknown op ' + op);
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const ObjectType = {
  Plist: 'plist',
  Hashtable: 'hashtable',
  Alist: 'alist',
};

const OBJECT_TYPE_VALUES = [ObjectType.Plist, ObjectType.Hashtable, ObjectType.Alist];

function objectTypeFromStr(s) {
  // clap's ValueEnum derives kebab-case names from the variants.
  if (OBJECT_TYPE_VALUES.includes(s)) return s;
  throw new Error("invalid value '" + s + "' for object type");
}

function defaultBytecodeOptions() {
  return {
    objectType: ObjectType.Plist,
    // TODO: array_type
    nullValue: LispObject.nil(),
    falseValue: LispObject.nil(),
  };
}

function debugLispObject(obj) {
  switch (obj.type) {
    case 'nil':
      return 'Nil';
    case 't':
      return 'T';
    case 'keyword':
      return 'Keyword(' + JSON.stringify(obj.value) + ')';
    case 'symbol':
      return 'Symbol(' + JSON.stringify(obj.value) + ')';
    case 'str':
      return 'Str(' + JSON.stringify(obj.value) + ')';
    case 'int':
      return 'Int(' + obj.value + ')';
    case 'float':
      return 'Float(' + JSON.stringify(obj.value) + ')';
    default:
      return obj.type;
  }
}

/** `{:?}` of BytecodeOptions, used in the startup log line. */
function formatBytecodeOptions(options) {
  const variant = {
    [ObjectType.Plist]: 'Plist',
    [ObjectType.Hashtable]: 'Hashtable',
    [ObjectType.Alist]: 'Alist',
  }[options.objectType];
  return (
    'BytecodeOptions { object_type: ' +
    variant +
    ', null_value: ' +
    debugLispObject(options.nullValue) +
    ', false_value: ' +
    debugLispObject(options.falseValue) +
    ' }'
  );
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

const ARRAY_CHUNK_SIZE = (1 << 16) - 1;

// Only for generating json. Sequential execution only.
class BytecodeCompiler {
  constructor(options) {
    this.options = options;
    // Ops stored as two parallel arrays to keep large payloads cheap.
    this.opTags = [];
    this.opArgs = [];
    // key -> { obj, idx, count }
    this.constants = new Map();
  }

  emit(op, arg = 0) {
    this.opTags.push(op);
    this.opArgs.push(arg);
  }

  compileConstantOp(obj) {
    const key = constantKey(obj);
    let idx;
    const existing = this.constants.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      idx = existing.idx;
    } else {
      idx = this.constants.size;
      this.constants.set(key, { obj, idx, count: 1 });
    }
    this.emit(Op.PushConstant, idx);
  }

  compileValueArray(arr) {
    if (arr.length === 0) {
      this.compileConstantOp(LispObject.symbol('vector'));
      this.emit(Op.Call, 0);
      return;
    }

    const chunksLen = Math.ceil(arr.length / ARRAY_CHUNK_SIZE);
    if (chunksLen >= 1 << 16) {
      throw new Error('Too many array chunks! ' + chunksLen);
    }

    if (chunksLen > 1) {
      // prepare a "vconcat" function, to concat multiple vectors
      this.compileConstantOp(LispObject.symbol('vconcat'));
    }

    for (let start = 0; start < arr.length; start += ARRAY_CHUNK_SIZE) {
      const end = Math.min(start + ARRAY_CHUNK_SIZE, arr.length);
      this.compileConstantOp(LispObject.symbol('vector'));
      for (let i = start; i < end; i++) {
        this.compileValue(arr[i]);
      }
      this.emit(Op.Call, end - start);
    }

    if (chunksLen > 1) {
      // call vconcat
      this.emit(Op.Call, chunksLen);
    }
  }

  compileValueMapPlistOrAlist(entries, alist) {
    const listLen = alist ? entries.length : entries.length * 2;
    // see below
    if (listLen < 1 << 16 && listLen >= 1 << 8) {
      this.compileConstantOp(LispObject.symbol('list'));
    }

    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      const value = entries[i][1];
      if (alist) {
        this.compileConstantOp(LispObject.symbol(key));
        this.compileValue(value);
        this.emit(Op.Cons);
      } else {
        this.compileConstantOp(LispObject.keyword(key));
        this.compileValue(value);
      }
    }

    // four modes: 0. (empty) just nil 1. list op; 2. list call; 3. recursive cons
    if (listLen === 0) {
      this.compileConstantOp(LispObject.nil());
    } else if (listLen < 1 << 8) {
      this.emit(Op.List, listLen);
    } else if (listLen < 1 << 16) {
      this.emit(Op.Call, listLen);
    } else {
      this.compileConstantOp(LispObject.nil());
      for (let i = 0; i < listLen; i++) {
        this.emit(Op.Cons);
      }
    }
  }

  compileValueMapHashtable(entries) {
    this.compileConstantOp(LispObject.symbol('make-hash-table'));
    this.compileConstantOp(LispObject.keyword('test'));
    this.compileConstantOp(LispObject.symbol('equal'));
    this.compileConstantOp(LispObject.keyword('size'));
    this.compileConstantOp(LispObject.int(entries.length));
    this.emit(Op.Call, 4);

    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      const value = entries[i][1];
      this.compileConstantOp(LispObject.symbol('puthash'));
      this.compileConstantOp(LispObject.str(key));
      this.compileValue(value);
      this.emit(Op.StackRef, 3);
      this.emit(Op.Call, 3);
      this.emit(Op.Discard);
    }
  }

  compileValue(value) {
    switch (value.t) {
      case 'null':
        this.compileConstantOp(this.options.nullValue);
        return;
      case 'bool':
        if (value.v) this.compileConstantOp(LispObject.t());
        else this.compileConstantOp(this.options.falseValue);
        return;
      case 'int':
        this.compileConstantOp(LispObject.int(value.v));
        return;
      case 'float':
        this.compileConstantOp(LispObject.float(formatFloat(value.v)));
        return;
      case 'str':
        this.compileConstantOp(LispObject.str(value.v));
        return;
      case 'arr':
        this.compileValueArray(value.v);
        return;
      case 'obj':
        switch (this.options.objectType) {
          case ObjectType.Plist:
            this.compileValueMapPlistOrAlist(value.v, false);
            return;
          case ObjectType.Alist:
            this.compileValueMapPlistOrAlist(value.v, true);
            return;
          case ObjectType.Hashtable:
            this.compileValueMapHashtable(value.v);
            return;
          default:
            throw new Error('unknown object type ' + this.options.objectType);
        }
      default:
        throw new Error('unknown json value tag ' + value.t);
    }
  }

  compile(value) {
    this.compileValue(value);
    this.emit(Op.Return);
  }

  /** @returns {{code: Buffer, constants: object[], maxStackSize: number}} */
  intoBytecode() {
    // optimize constants vector, sort by usage
    const entries = Array.from(this.constants.values());
    entries.sort(
      // if count is same, still sort by the old idx, to increase locality
      (a, b) => b.count - a.count || a.idx - b.idx,
    );

    const indexRemap = new Int32Array(entries.length);
    for (let newIdx = 0; newIdx < entries.length; newIdx++) {
      indexRemap[entries[newIdx].idx] = newIdx;
    }

    let constantsArray = entries.map((e) => e.obj);
    // rearrange constants
    const twoLevelVectors = [];
    // collect two level vectors from the end (reverse order)
    while (constantsArray.length > CV_NORMAL_SLOT_COUNT) {
      const remaining =
        (constantsArray.length - CV_NORMAL_SLOT_COUNT) % CV_TWO_LEVEL_VECTOR_SIZE;
      const len = remaining === 0 ? CV_TWO_LEVEL_VECTOR_SIZE : remaining;
      const v = constantsArray.splice(constantsArray.length - len, len);
      twoLevelVectors.push(LispObject.vector(v));
    }
    twoLevelVectors.reverse();

    if (twoLevelVectors.length > 0) {
      if (constantsArray.length !== CV_NORMAL_SLOT_COUNT) {
        throw new Error(
          'internal error: constants length ' +
            constantsArray.length +
            ' != ' +
            CV_NORMAL_SLOT_COUNT,
        );
      }
      for (let i = 0; i < CV_TWO_LEVEL_VECTOR_SIZE; i++) {
        constantsArray.push(LispObject.int(i));
      }
      constantsArray = constantsArray.concat(twoLevelVectors);
    }

    const code = new ByteBuf();
    let currentStackSize = 0;
    let maxStackSize = 0;
    for (let i = 0; i < this.opTags.length; i++) {
      const op = this.opTags[i];
      const arg = op === Op.PushConstant ? indexRemap[this.opArgs[i]] : this.opArgs[i];
      emitCode(code, op, arg);
      currentStackSize += getStackDelta(op, arg);
      if (currentStackSize > maxStackSize) maxStackSize = currentStackSize;
    }

    // some buffer for max stack size (for the PushConstant variant)
    return {
      code: code.toBuffer(),
      constants: constantsArray,
      maxStackSize: maxStackSize + 8,
    };
  }

  intoRepl() {
    const r = this.intoBytecode();
    return (
      '#[0 ' +
      unibyteStrToRepl(r.code) +
      ' ' +
      toRepl(LispObject.vector(r.constants)) +
      ' ' +
      r.maxStackSize +
      ']'
    );
  }
}

/**
 * @param {object} value parsed by ./json
 * @param {object} options BytecodeOptions
 * @returns {string}
 */
function generateBytecodeRepl(value, options) {
  const compiler = new BytecodeCompiler(options);
  compiler.compile(value);
  return compiler.intoRepl();
}

module.exports = {
  LispObject,
  lispObjectFromStr,
  lispObjectEquals,
  debugLispObject,
  toRepl,
  ObjectType,
  OBJECT_TYPE_VALUES,
  objectTypeFromStr,
  defaultBytecodeOptions,
  formatBytecodeOptions,
  generateBytecodeRepl,
  BytecodeCompiler,
  Op,
  CV_NORMAL_SLOT_COUNT,
  CV_TWO_LEVEL_VECTOR_SIZE,
};
