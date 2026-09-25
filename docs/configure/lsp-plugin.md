---
description: "Configure the optional generic LSP plugin for semantic code navigation and approved refactors."
---

# Language Server Protocol plugin

`plugins/lsp` is an optional TypeScript plugin. When enabled for an agent, it starts the configured
language server for the active project at the beginning of a run. As Jazz reads and changes source
files, the plugin keeps those documents current and adds relevant diagnostics to the agent's next
model request. The agent does not need to call an LSP tool to receive that context. Targeted tools
remain available for document and workspace symbols, definitions, references, hover, code actions,
symbol rename, and document formatting. The plugin works with servers that speak LSP 3.17 over stdio
and implement the requested methods. There is no language server bundled with Jazz.

Pack the plugin from this repository with `bun run plugin:pack plugins/lsp`, then install the
generated `plugins/lsp/release/catalog-entry.json` through the normal
[plugin lifecycle](./plugins.md). Trust and enable it for the agent. The pack step bundles its
diff renderer into a self-contained artifact. Configure server commands in `~/.jazz/lsp.json`:

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

Install `typescript-language-server` and a compatible `typescript` version separately if you use
this example. TypeScript 6 worked with the language server in our live test; the TypeScript 7
package we tried did not include the `tsserver.js` that server expected. To configure another
language, add an entry with its executable, argument vector, extensions,
language ID, and project-root markers. The first entry matching a file extension wins. The
plugin walks upward from the current directory to identify configured project roots and starts
their servers before the first model request. It also starts a matching server when Jazz later
touches a supported file outside those roots. If no marker exists, it uses the agent's current
directory. `JAZZ_LSP_CONFIG` can point to another JSON file. A missing or invalid config is
reported to the agent.

The plugin reads source files from disk and sends `didOpen` and `didChange` as Jazz works with them.
It checks tracked files again before each model request, including after external edits. It keeps
diagnostics bounded and relevant to those files; it does not pour whole-workspace diagnostics into
every turn. A failed server start is retried after a short delay rather than on every model request;
an unavailable server does not stop the coding run. The model cannot choose the
executable or its arguments.

The tools use **1-based** line and UTF-16 character coordinates. `code_actions` lists available
actions for a range. `apply_code_action` selects one by its exact title, with a zero-based `index`
when titles repeat, and resolves lazy edits when the server supports it. Actions without an edit
are rejected. `rename_symbol`, `apply_code_action`, and `format_document` turn the returned
`WorkspaceEdit` into a multi-file diff for Jazz's normal approval flow. Jazz persists the prepared
edit if approval is parked. At execution, the plugin locks every target and checks its complete
content digest before replacing files; a changed file produces a stale-edit error and writes
nothing. It also rejects a server response if the source file changed while the server was
preparing the edit. Resource operations such as create, delete, and move are rejected explicitly. LSP
servers' unsolicited `workspace/applyEdit` requests are refused.

Semantic query tools are declared `read-only`. Rename, code action application, and formatting are
declared `high-risk` and use Jazz's approval gate. The configured server command is part of the
operator's plugin setup and trust decision, not a model-authored shell command. The operator must
trust that executable, just as with any plugin that runs local code. The server receives source
contents from files Jazz reads or changes during the agent's run, as well as files the agent
explicitly queries through an LSP tool. Its stdout is untrusted protocol data;
code action commands are never executed. The plugin performs no network egress itself, but a
configured server may have its own network behavior. Review the server before enabling the
plugin on a remote or unattended surface.

The current edit path validates all files before writing and uses sibling temporary files plus
atomic per-file renames. A multi-file edit is not one filesystem transaction: an I/O failure
during replacement can leave a partial set of files changed. External programs that ignore
Jazz's edit locks can also race after validation.
