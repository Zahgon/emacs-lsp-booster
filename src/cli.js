'use strict';

// Port of src/main.rs (argument parsing, logger setup, process wiring).

const path = require('node:path');
const fs = require('node:fs');

const { LevelFilter, setLevelFilter, levelFilterLabel, logger } = require('./log');
const bytecode = require('./bytecode');
const app = require('./app');

const log = logger('emacs_lsp_booster');

const NAME = 'emacs-lsp-booster';
const VERSION = require('../package.json').version;

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** Thrown for --help / --version, which clap treats as a successful exit. */
class CliExit extends Error {
  constructor(output, exitCode = 0, stream = 'stdout') {
    super('cli exit');
    this.name = 'CliExit';
    this.output = output;
    this.exitCode = exitCode;
    this.stream = stream;
  }
}

function helpText() {
  // Byte-identical to the reference implementation's clap output.
  return "Usage: emacs-lsp-booster [OPTIONS] [-- <SERVER_CMD>...]\n\nArguments:\n  [SERVER_CMD]...  \n\nOptions:\n  -v, --verbose...\n          Increase logging verbosity\n  -q, --quiet...\n          Decrease logging verbosity\n  -n, --disable-bytecode\n          Disable bytecode generation. Simply forward server json as-is. Useful for debugging or benchmarking.\n      --json-object-type <JSON_OBJECT_TYPE>\n          Lisp type used to represent a JSON object. Plist is the most performant one.\n          Must match what lsp client expects.\n           [default: plist] [possible values: plist, hashtable, alist]\n      --json-null-value <JSON_NULL_VALUE>\n          Which lisp value is used to represent a JSON null value. Support :keyword or nil.\n          Must match what lsp client expects.\n           [default: nil]\n      --json-false-value <JSON_FALSE_VALUE>\n          Which lisp value is used to represent a JSON false value. Support :keyword or nil.\n          Must match what lsp client expects.\n           [default: nil]\n  -h, --help\n          Print help\n  -V, --version\n          Print version\n\nFor backward compatibility, `emacs-lsp-booster <SERVER_CMD>...` (without any options) is also supported\n";
}

function versionText() {
  return NAME + ' ' + VERSION + '\n';
}

/** clap-verbosity-flag with InfoLevel as the default. */
function logLevelFilter(verbose, quiet) {
  const index = 2 + verbose - quiet;
  if (index < 0) return LevelFilter.Off;
  return Math.min(index + 1, LevelFilter.Trace);
}

const LONG_VALUE_OPTS = new Set([
  'json-object-type',
  'json-null-value',
  'json-false-value',
]);

function parseFrom(args) {
  const cli = {
    verbose: 0,
    quiet: 0,
    serverCmd: [],
    disableBytecode: false,
    jsonObjectType: bytecode.ObjectType.Plist,
    jsonNullValue: bytecode.LispObject.nil(),
    jsonFalseValue: bytecode.LispObject.nil(),
  };
  cli.logLevelFilter = () => logLevelFilter(cli.verbose, cli.quiet);

  // arg_required_else_help
  if (args.length <= 1) {
    throw new CliExit(helpText(), 2, 'stderr');
  }

  const takeValue = (i, name, inlineValue) => {
    if (inlineValue !== null) return { value: inlineValue, next: i };
    if (i + 1 >= args.length) {
      throw new CliError(
        "error: a value is required for '--" +
          name +
          ' <' +
          name.toUpperCase().replace(/-/g, '_') +
          ">' but none was supplied",
      );
    }
    return { value: args[i + 1], next: i + 1 };
  };

  const applyLongValue = (name, value) => {
    const placeholder = name.toUpperCase().replace(/-/g, '_');
    try {
      if (name === 'json-object-type') {
        cli.jsonObjectType = bytecode.objectTypeFromStr(value);
      } else if (name === 'json-null-value') {
        cli.jsonNullValue = bytecode.lispObjectFromStr(value);
      } else if (name === 'json-false-value') {
        cli.jsonFalseValue = bytecode.lispObjectFromStr(value);
      }
    } catch (err) {
      // clap's ValueEnum reports the accepted set on its own line; a
      // value-parser (TypedValueParser) instead appends its own message inline.
      const head =
        "error: invalid value '" + value + "' for '--" + name + ' <' + placeholder + ">'";
      if (name === 'json-object-type') {
        throw new CliError(head + '\n  [possible values: plist, hashtable, alist]');
      }
      throw new CliError(head + ': ' + err.message);
    }
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      cli.serverCmd = args.slice(i + 1);
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq >= 0 ? arg.slice(eq + 1) : null;

      if (LONG_VALUE_OPTS.has(name)) {
        const taken = takeValue(i, name, inline);
        applyLongValue(name, taken.value);
        i = taken.next;
        continue;
      }
      if (inline !== null) {
        throw new CliError("error: unexpected value '" + inline + "' for '--" + name + "'");
      }
      switch (name) {
        case 'help':
          throw new CliExit(helpText(), 0, 'stdout');
        case 'version':
          throw new CliExit(versionText(), 0, 'stdout');
        case 'verbose':
          cli.verbose += 1;
          continue;
        case 'quiet':
          cli.quiet += 1;
          continue;
        case 'disable-bytecode':
          cli.disableBytecode = true;
          continue;
        default:
          throw new CliError("error: unexpected argument '" + arg + "' found");
      }
    }

    if (arg.length > 1 && arg.startsWith('-')) {
      for (const ch of arg.slice(1)) {
        switch (ch) {
          case 'v':
            cli.verbose += 1;
            break;
          case 'q':
            cli.quiet += 1;
            break;
          case 'n':
            cli.disableBytecode = true;
            break;
          case 'h':
            throw new CliExit(helpText(), 0, 'stdout');
          case 'V':
            throw new CliExit(versionText(), 0, 'stdout');
          default:
            throw new CliError("error: unexpected argument '-" + ch + "' found");
        }
      }
      continue;
    }

    // `#[arg(last = true)]` means SERVER_CMD is only reachable after `--`.
    throw new CliError("error: unexpected argument '" + arg + "' found");
  }

  return cli;
}

/**
 * `parse_args` from main.rs, including the backward-compatible form.
 * @param {string[]} args argv with the program name at index 0
 */
function parseArgs(args) {
  const argv = args.map((x) => String(x));
  // backward compatible. support `emacs-lsp-booster server_cmd args...` directly
  if (argv.length > 1 && !argv[1].startsWith('-') && !argv.includes('--')) {
    const fakeArgs = [argv[0], '--'].concat(argv.slice(1));
    return parseFrom(fakeArgs);
  }
  return parseFrom(argv);
}

/** Windows: Command::new cannot find .cmd files, so resolve through PATH. */
function resolveServerProgram(program) {
  if (process.platform !== 'win32') {
    return program;
  }
  if (program.includes(path.sep) || program.includes('/')) {
    return program;
  }
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of [''].concat(exts)) {
      const candidate = path.join(dir, program + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  throw new Error('cannot find binary path: ' + program);
}

async function main(argv = process.argv) {
  // Rust sees [prog, ...]; Node sees [node, script, ...].
  const args = [NAME].concat(argv.slice(2));

  let cli;
  try {
    cli = parseArgs(args);
  } catch (err) {
    if (err instanceof CliExit) {
      process[err.stream].write(err.output);
      return err.exitCode;
    }
    if (err instanceof CliError) {
      process.stderr.write(err.message + '\n\n' + helpText());
      return err.exitCode;
    }
    throw err;
  }

  setLevelFilter(cli.logLevelFilter());

  if (cli.serverCmd.length === 0) {
    process.stderr.write('Error: Please specify the server command\n');
    return 1;
  }

  let serverCmdProg;
  try {
    serverCmdProg = resolveServerProgram(cli.serverCmd[0]);
  } catch (err) {
    process.stderr.write('Error: ' + err.message + '\n');
    return 1;
  }
  log.trace('Using server prog: ' + JSON.stringify(serverCmdProg));

  const serverCmd = { program: serverCmdProg, args: cli.serverCmd.slice(1) };

  let status;
  try {
    status = await app.runAppForever(process.stdin, process.stdout, serverCmd, {
      bytecodeOptions: cli.disableBytecode
        ? null
        : {
            objectType: cli.jsonObjectType,
            nullValue: cli.jsonNullValue,
            falseValue: cli.jsonFalseValue,
          },
    });
  } catch (err) {
    // The Rust build installs a panic hook that exits(1) if any worker thread
    // fails; the equivalent here is a rejected runAppForever.
    process.stderr.write('Error: ' + err.message + '\n');
    return 1;
  }

  return status.code === null ? 1 : status.code;
}

module.exports = {
  main,
  parseArgs,
  logLevelFilter,
  helpText,
  versionText,
  CliError,
  CliExit,
  LevelFilter,
  levelFilterLabel,
  VERSION,
};
