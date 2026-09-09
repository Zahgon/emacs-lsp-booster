# emacs-lsp-booster (JavaScript port)

A JavaScript port of [blahgeek/emacs-lsp-booster](https://github.com/blahgeek/emacs-lsp-booster) v0.2.1.

It wraps an LSP server executable, converts the server's JSON messages into
elisp bytecode (text representation) before handing them to Emacs, and
decouples reading from writing so neither side blocks the other.

## Requirements

Node.js >= 18. No dependencies.

## Usage

```sh
emacs-lsp-booster [OPTIONS] -- <SERVER_CMD>...
emacs-lsp-booster <SERVER_CMD>...          # backward-compatible form
```

## Source mapping

| Rust | JavaScript |
| --- | --- |
| `src/bytecode.rs` | `src/bytecode.js` |
| `src/rpcio.rs` | `src/rpcio.js` |
| `src/lsp_message.rs` | `src/lspMessage.js` |
| `src/app.rs` | `src/app.js` |
| `src/main.rs` | `src/cli.js`, `bin/emacs-lsp-booster.js` |
| `src/lib.rs` | `src/index.js` |

## Tests

```sh
npm test
```
