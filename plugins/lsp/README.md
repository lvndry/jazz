# LSP plugin

This optional Jazz plugin connects an agent to language servers you install and configure. It
starts servers for the active project, keeps files Jazz reads or changes synchronized, and gives
the agent relevant diagnostics before its next model request. The agent does not need to call an
LSP tool for diagnostics. Explicit tools also provide symbols, definitions, references, hover,
code actions, rename, and formatting when the server supports them.

## Enable the plugin

Install the published plugin directly from your terminal. No repository clone or build is needed:

```sh
jazz plugin add com.jazz.plugins.lsp
jazz plugin inspect com.jazz.plugins.lsp
jazz plugin trust com.jazz.plugins.lsp
jazz plugin enable com.jazz.plugins.lsp --agent default
```

Replace `default` with your agent name or ID, or omit `--agent` to enable it for every agent. The
language-server executable is installed separately; Jazz does not bundle one. See "Add a language"
below for TypeScript, Python, Rust, Go, and HTML/CSS.

## Add a language

Create or edit `~/.jazz/lsp.json`. Add one object per language server to the `servers` array; keep
any existing entries when adding another. Use the absolute path from `command -v <the-executable>`
for `command` if Jazz cannot find it on its own `PATH`.

### TypeScript and JavaScript

Install [`typescript-language-server`](https://github.com/typescript-language-server/typescript-language-server):

```sh
npm install --global typescript-language-server typescript@6
```

```json
{
  "servers": [
    {
      "id": "typescript",
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      },
      "rootMarkers": ["tsconfig.json", "package.json"]
    },
    {
      "id": "javascript",
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": {
        ".js": "javascript",
        ".jsx": "javascriptreact"
      },
      "rootMarkers": ["jsconfig.json", "package.json"]
    }
  ]
}
```

### Python

Install [`pyright`](https://microsoft.github.io/pyright/#/installation), which ships a
`pyright-langserver` binary:

```sh
npm install --global pyright
```

```json
{
  "servers": [
    {
      "id": "python",
      "command": "pyright-langserver",
      "args": ["--stdio"],
      "extensions": { ".py": "python" },
      "rootMarkers": [
        "pyrightconfig.json",
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "requirements.txt"
      ]
    }
  ]
}
```

Two alternatives, same `extensions` and `rootMarkers` as above:

- [`python-lsp-server`](https://github.com/python-lsp/python-lsp-server) — `pip install
python-lsp-server`, then `command: "pylsp"` with `args: []`.
- [`ty`](https://github.com/astral-sh/ty), Astral's Rust-based type checker (pre-1.0, moving
  fast) — `uv tool install ty`, then `command: "ty"` with `args: ["server"]`. If you run it through
  `uvx` instead of installing it, use `command: "uvx"` with `args: ["ty", "server"]`.

### Rust

Install [`rust-analyzer`](https://rust-analyzer.github.io/book/installation.html):

```json
{
  "servers": [
    {
      "id": "rust",
      "command": "rust-analyzer",
      "args": [],
      "extensions": { ".rs": "rust" },
      "rootMarkers": ["Cargo.toml"]
    }
  ]
}
```

### HTML and CSS

Install [`vscode-langservers-extracted`](https://github.com/vscode-langservers-extracted/vscode-langservers-extracted), which ships stdio servers for the VS Code HTML and CSS language services in one package:

```sh
npm install --global vscode-langservers-extracted
```

```json
{
  "servers": [
    {
      "id": "html",
      "command": "vscode-html-language-server",
      "args": ["--stdio"],
      "extensions": {
        ".html": "html",
        ".htm": "html"
      },
      "rootMarkers": ["index.html", "package.json"]
    },
    {
      "id": "css",
      "command": "vscode-css-language-server",
      "args": ["--stdio"],
      "extensions": { ".css": "css" },
      "rootMarkers": ["package.json"]
    }
  ]
}
```

The HTML server covers `.html` files including the CSS inside their inline `<style>`
blocks, plus validation of embedded JavaScript. The CSS server covers standalone
`.css` files. Both provide diagnostics (they use the LSP 3.17 pull model, which
the plugin queries directly), hover, symbols, definitions, and references.
Neither provides document formatting. Adjust `rootMarkers` to your project's
layout; with no marker present the plugin uses the current directory.

Do not use `vscode-html-languageserver-bin` / `vscode-css-languageserver-bin`
instead: their pinned `vscode-jsonrpc` is stale and the servers crash at
startup (`messageReader.onClose is not a function`).

### Go

Install [`gopls`](https://pkg.go.dev/golang.org/x/tools/gopls):

```sh
go install golang.org/x/tools/gopls@latest
```

```json
{
  "servers": [
    {
      "id": "go",
      "command": "gopls",
      "args": [],
      "extensions": { ".go": "go" },
      "rootMarkers": ["go.work", "go.mod"]
    }
  ]
}
```

The fields mean:

| Field         | Meaning                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`          | A name for this configuration entry.                                                                                 |
| `command`     | The executable Jazz starts. It must be available on Jazz's `PATH`, or be an absolute path.                           |
| `args`        | Command arguments as an array, such as `["--stdio"]` when the server requires it.                                    |
| `extensions`  | File extensions handled by this entry (with the leading dot), each mapped to the LSP language ID Jazz opens it with. |
| `rootMarkers` | Filenames used to find the project root while walking up from a file or current directory.                           |

Each extension is bound to exactly one language ID, because a file's language determines how the
server parses it: the React dialects (`.tsx`, `.jsx`) must open as `typescriptreact` /
`javascriptreact`, never as plain `typescript` or `javascript`. A legacy top-level `languageId` is
rejected at load time with a message that names the replacement. Jazz chooses the first entry whose
`extensions` names the file's extension. At the beginning of a run it starts configured servers
whose root markers identify the active project. If a matching file is read or changed later, Jazz
starts its server then and supplies diagnostics on the next model request. A new configuration is
read on the next request; changing the executable starts a new server, while an old idle server
exits after two minutes. Use `JAZZ_LSP_CONFIG` to point to a different JSON file.

The Python, Rust, and Go entries above illustrate the configuration format; Jazz's live server
verification has covered TypeScript and HTML/CSS, not the other languages. For the tested setup,
approval behavior, and current limitations, see the [full LSP guide](../../docs/configure/lsp-plugin.md).
