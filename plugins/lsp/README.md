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
below for TypeScript, Python, Rust, and Go.

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
      "extensions": [".ts", ".tsx"],
      "languageId": "typescript",
      "rootMarkers": ["tsconfig.json", "package.json"]
    },
    {
      "id": "javascript",
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": [".js", ".jsx"],
      "languageId": "javascript",
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
      "extensions": [".py"],
      "languageId": "python",
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

Two alternatives, same `extensions`, `languageId`, and `rootMarkers` as above:

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
      "extensions": [".rs"],
      "languageId": "rust",
      "rootMarkers": ["Cargo.toml"]
    }
  ]
}
```

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
      "extensions": [".go"],
      "languageId": "go",
      "rootMarkers": ["go.work", "go.mod"]
    }
  ]
}
```

The fields mean:

| Field         | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| `id`          | A name for this configuration entry.                                                       |
| `command`     | The executable Jazz starts. It must be available on Jazz's `PATH`, or be an absolute path. |
| `args`        | Command arguments as an array, such as `["--stdio"]` when the server requires it.          |
| `extensions`  | File extensions handled by this entry, including the leading dot.                          |
| `languageId`  | The LSP language identifier sent when Jazz opens a file.                                   |
| `rootMarkers` | Filenames used to find the project root while walking up from a file or current directory. |

The server must speak LSP 3.17 over standard input and output. Jazz chooses the first entry whose
`extensions` contains the file's extension. At the beginning of a run it starts configured servers
whose root markers identify the active project. If a matching file is read or changed later, Jazz
starts its server then and supplies diagnostics on the next model request. A new configuration is
read on the next request; changing the executable starts a new server, while an old idle server
exits after two minutes. Use `JAZZ_LSP_CONFIG` to point to a different JSON file.

The Python, Rust, and Go entries above illustrate the configuration format; Jazz's live server
verification has covered TypeScript, not the other three. For the tested TypeScript setup,
approval behavior, and current limitations, see the [full LSP guide](../../docs/configure/lsp-plugin.md).
