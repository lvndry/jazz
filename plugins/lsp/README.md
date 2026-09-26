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
language-server executable is installed separately; Jazz does not bundle one.

## Add a language

Create or edit `~/.jazz/lsp.json`. Add one object per language server to the `servers` array. For
example, after [installing `rust-analyzer`](https://rust-analyzer.github.io/book/installation.html)
and making its executable available to Jazz, this config adds Rust:

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

Keep any existing server objects when adding another language. The fields mean:

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

The Rust entry above illustrates the configuration format; Jazz's live server verification has
covered TypeScript, not Rust. For the tested TypeScript setup, approval behavior, and current
limitations, see the [full LSP guide](../../docs/configure/lsp-plugin.md).
