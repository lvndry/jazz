---
name: obsidian
description: "Use the official Obsidian CLI (v1.12+) to manage vaults, notes, daily notes, search, tasks, tags, properties, links, templates, sync, publish, and workspaces. Use when the user mentions Obsidian, vaults, notes, or wants to automate note-taking and knowledge base workflows."
---

# Obsidian CLI

Use the **official Obsidian CLI** ([help.obsidian.md/cli](https://help.obsidian.md/cli)) to control Obsidian from the terminal. The CLI connects to a running Obsidian instance via IPC.

## When to Use

- User asks about Obsidian or vaults.
- User wants to manage notes (open, create, read, append, move, delete).
- User wants daily notes, search, tasks, tags, or properties.
- User wants to automate templates, sync, publish, or workspaces.
- User asks for rich documentation with LaTeX, callouts, or diagrams (create content with Obsidian-flavored markdown).

## Prerequisites

- **Obsidian 1.12+** installed and **running**
- CLI enabled: **Settings → General → Command line interface**
- The `obsidian` binary in your PATH

**Important:** The CLI talks to the running app via IPC. Obsidian must be open for commands to work.

### Platform Notes

- **macOS/Windows:** Installer usually adds the CLI to PATH.
- **Linux:** You may need a wrapper so Electron flags don’t break CLI args; ensure IPC socket is available (e.g. `PrivateTmp=false` for systemd).

## Command Overview (from official docs)

Syntax: `obsidian [vault=Name] <command> [params]`. Use `param=value`; quote values with spaces. Use `vault=` as the **first** parameter to target a vault.

### General

```bash
obsidian help                    # List commands or help for a command
obsidian version                 # Obsidian version
obsidian reload                  # Reload the app window
obsidian restart                 # Restart the app
```

### Vault

```bash
obsidian vault                   # Current vault info (name, path, files, size)
obsidian vault info=name         # Vault name only
obsidian vault info=path         # Vault path only
obsidian vaults                  # List known vaults (desktop)
obsidian vault=MyVault <cmd>     # Run command in vault MyVault (must be first)
```

### Files and Folders

```bash
obsidian read file=Recipe                # Read by name (wikilink resolution)
obsidian read path="Work/notes.md"       # Read by exact path
obsidian file file=Recipe               # File info (path, size, dates)
obsidian create name=Note               # Create empty note (prefer path + write_file for content)
obsidian create name=Note template=Travel   # Create from template
obsidian create path="Work/note.md"     # Create empty at path
obsidian create name=Note overwrite     # Overwrite if exists
obsidian open file=Recipe               # Open in Obsidian
obsidian open file=Recipe newtab        # Open in new tab
obsidian append file=Log content="Line" # Append to file
obsidian prepend file=Log content="# H"  # Prepend (after frontmatter)
obsidian move file=Old to="Archive/Old.md"  # Move/rename (include .md)
obsidian delete file=Old                # Delete to trash
obsidian delete file=Old permanent      # Delete permanently
obsidian files total                    # File count
obsidian files folder="Work" ext=md     # Filter by folder/extension
obsidian folders                        # List folders
obsidian folder path="Work" info=size   # Folder size
```

### Daily Notes

```bash
obsidian daily                      # Open today's daily note
obsidian daily silent               # Open without focusing
obsidian daily:read                 # Read daily note contents
obsidian daily:path                 # Get daily note path
obsidian daily:append content="- [ ] Task"
obsidian daily:prepend content="# Header"
```

### Search

```bash
obsidian search query="meeting notes"
obsidian search query="TODO" matches    # With context
obsidian search query="x" path="Work" limit=10
obsidian search:open query="TODO"       # Open search in app
```

### Tasks

```bash
obsidian tasks daily                  # Tasks in daily note
obsidian tasks daily todo             # Incomplete
obsidian tasks all todo               # All incomplete in vault
obsidian task daily line=3 toggle     # Toggle completion
obsidian task daily line=3 done       # Mark done
obsidian task ref="path/to.md:5" toggle
```

### Tags and Properties

```bash
obsidian tags all counts
obsidian tags file=Note
obsidian tag name=project total
obsidian properties file=Note
obsidian property:read name=status file=Note
obsidian property:set name=status value=done file=Note
obsidian property:remove name=status file=Note
obsidian aliases
```

### Links and Outline

```bash
obsidian backlinks file=Note
obsidian links file=Note
obsidian unresolved
obsidian orphans
obsidian deadends
obsidian outline file=Note
```

### Templates

```bash
obsidian templates
obsidian template:read name=Daily
obsidian template:read name=Daily resolve title="My Note"
obsidian template:insert name=Daily    # Into active file
```

### History and Sync

```bash
obsidian history file=Note
obsidian history:list
obsidian history:read file=Note version=3
obsidian history:restore file=Note version=3
obsidian diff file=Note from=1 to=3
obsidian sync:status
obsidian sync:history file=Note
obsidian sync:restore file=Note version=2
```

### Other

```bash
obsidian random
obsidian random:read
obsidian wordcount file=Note
obsidian bookmarks
obsidian bookmark file="note.md" title="My Note"
obsidian bases
obsidian base:query file=MyBase format=json
obsidian workspace:save name="coding"
obsidian workspace:load name="coding"
obsidian plugins
obsidian plugin:enable id=dataview
obsidian theme:set name="Minimal"
obsidian publish:add file=Note
obsidian web url="https://example.com"
```

## Best Practices

1. **Vault:** Always specify `vault=Name`. If CWD is inside a vault, that vault is used; otherwise confirm vault to use.
2. **Ask first:** For big or structured notes, confirm depth, visuals (images, LaTeX, Mermaid), and organization (single note, folder, canvas).
3. **File vs path:** `file=` uses wikilink-style resolution (name only). Use `path=` for an exact path from vault root.
4. **Quoting:** Use quotes for values with spaces: `content="Hello world"`.
5. **Rich content:** Use [Obsidian Advanced Syntax](https://help.obsidian.md/advanced-syntax) and [Obsidian Flavored Markdown](https://help.obsidian.md/obsidian-flavored-markdown) for callouts, LaTeX, Mermaid. Add YAML frontmatter (tags, status, dates) for discoverability.
6. **Canvas:** For `.canvas` files, use colors "1"–"6" as strings; text nodes support full markdown. See `references/canvas-format.md` for structure.

### Writing note content: use path + write_file

The CLI can create **empty** notes or notes with **very small** content via `create`, but for any real note content **always** use the CLI only to get the path, then write with **write_file**:

1. **Get the full path** with the Obsidian CLI:
   - Vault root: `obsidian vault info=path` (then join with your relative path, e.g. `Research/MyNote.md`).
   - Daily note: `obsidian daily:path`.
   - Existing note path: `obsidian file file=NoteName` (or build path from vault root).
   - New note: `obsidian vault info=path` then `path_from_vault_root/NoteName.md`.
2. **Write the content** using the **write_file** skill (or your environment’s file write tool) to that absolute path.

Use `obsidian create name=Note` (no content) only when you need an empty file; for any content, get the path and use write_file. This avoids quoting/escaping, length limits, and fragile CLI argument handling.

## Troubleshooting

- **"Cannot connect"**: Obsidian must be running and CLI enabled in Settings → General.
- **"Command not found"**: Ensure `obsidian` is in PATH.
- **Linux:** Use a wrapper that doesn’t inject Electron flags; for systemd, set `PrivateTmp=false` so IPC works.

## References

- [Obsidian CLI](https://help.obsidian.md/cli) — Official CLI docs
- [Obsidian Advanced Syntax](https://help.obsidian.md/advanced-syntax)
- [Obsidian Flavored Markdown](https://help.obsidian.md/obsidian-flavored-markdown)
- [references/canvas-format.md](references/canvas-format.md) — Canvas JSON
- [references/markdown-features.md](references/markdown-features.md) — LaTeX, callouts, Mermaid
