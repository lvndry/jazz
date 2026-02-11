---
name: obsidian
description: "Operate Obsidian via its official CLI (Obsidian 1.12+) to create rich, visual notes with LaTeX, images, colors, callouts, and canvases. Use Obsidian's full potential to embed images, format with markdown, create colored canvas nodes, diagrams, and leverage advanced features. Use when the user mentions Obsidian, vaults, notes, or wants rich documentation."
---

# Obsidian CLI

Use the official [Obsidian CLI](https://help.obsidian.md/cli) (built into Obsidian 1.12+) to manage notes and vaults from the terminal.

> **Note:** The official `obsidian` command replaces the legacy third-party `obsidian-cli` (Yakitrak). Obsidian must be running for the CLI to work — the first command will launch it if needed.

## Installation

Requires **Obsidian 1.12+** (currently an early access version requiring a [Catalyst license](https://obsidian.md/pricing)).

1. Update to the latest Obsidian installer (1.11.7+) and enable the early access version (1.12.x).
2. Go to **Settings → General**.
3. Enable **Command line interface**.
4. Follow the prompt to register the CLI (adds `obsidian` to your PATH).
5. Restart your terminal for the PATH changes to take effect.

### Platform notes

- **macOS**: Registration adds the Obsidian binary to PATH via `~/.zprofile`. For non-zsh shells, add manually:
  - Bash: `export PATH="$PATH:/Applications/Obsidian.app/Contents/MacOS"` in `~/.bash_profile`
  - Fish: `fish_add_path /Applications/Obsidian.app/Contents/MacOS`
- **Linux**: Registration creates a symlink at `/usr/local/bin/obsidian` (requires sudo). For AppImage, Snap, or Flatpak installs, see the [official troubleshooting guide](https://help.obsidian.md/cli#Troubleshooting).
- **Windows**: Additionally requires downloading the `Obsidian.com` redirector file (available to Catalyst members on Discord) and placing it alongside `Obsidian.exe`.

## When to Use

- User asks about Obsidian.
- User wants to manage notes (open, search, create, move, delete).
- User wants rich documentation with LaTeX, callouts, or diagrams.
- User asks for canvases, diagrams or `.canvas` files.

## Core Philosophy: User-Driven Design

**Ask the user for their preferences** before creating complex structures. While you can create rich, visual notes, always check if they have specific requirements for:

- **Depth**: Quick summary vs. exhaustive guide.
- **Visuals**: Do they want images, LaTeX, or Mermaid diagrams?
- **Organization**: Should it be a single note, a folder structure, slides or a Canvas?

## Quick Start

1. **Vault Management**:
   - `obsidian vault` — show current vault info (name, path, file/folder counts).
   - `obsidian vaults verbose` — list all known vaults with paths.
   - `obsidian vault=<name> <command>` — target a specific vault (must be the first parameter).
2. **Note Operations**:
   - `obsidian create name="Note" content="Content"` — create a note.
   - `obsidian create name="Note" template=TemplateName` — create from template.
   - `obsidian open file=Note` — open a note.
   - `obsidian read file=Note` — read note contents.
   - `obsidian search query="term"` — search vault.
   - `obsidian property:set name="status" value="done" file=Note` — set frontmatter property.
   - `obsidian append file=Note content="New content"` — append to a note.
   - `obsidian prepend file=Note content="New content"` — prepend after frontmatter.
3. **CLI Help**:
   - `obsidian help` — list all available commands.

## Command Syntax

The official CLI uses `parameter=value` syntax (not `--flags`):

```shell
# Parameters take values
obsidian create name="My Note" content="Hello world"

# Flags are boolean switches with no value
obsidian create name="My Note" content="Hello" silent overwrite

# Multiline content uses \n
obsidian create name="My Note" content="# Title\n\nBody text"

# Target a vault (must be first parameter)
obsidian vault="My Vault" search query="test"

# Target files by name (wikilink resolution) or exact path
obsidian read file=Recipe
obsidian read path="Templates/Recipe.md"

# Copy output to clipboard
obsidian read file=Note --copy
```

## Key Commands Reference

### Files & Folders

| Command                        | Description                                                |
| ------------------------------ | ---------------------------------------------------------- |
| `create name=<n> content=<t>`  | Create a note (flags: `silent`, `overwrite`, `newtab`)     |
| `create name=<n> template=<t>` | Create from template                                       |
| `open file=<name>`             | Open a file                                                |
| `read file=<name>`             | Read file contents                                         |
| `append file=<n> content=<t>`  | Append content                                             |
| `prepend file=<n> content=<t>` | Prepend after frontmatter                                  |
| `move file=<n> to=<path>`      | Move or rename a file                                      |
| `delete file=<name>`           | Delete a file (trash by default, `permanent` flag to skip) |
| `files`                        | List files (params: `folder`, `ext`, flag: `total`)        |
| `folders`                      | List folders                                               |

### Search & Navigation

| Command                 | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `search query=<text>`   | Search vault (params: `path`, `limit`, `format`; flags: `total`, `matches`, `case`) |
| `tags all counts`       | List all tags with counts                                                           |
| `backlinks file=<name>` | List backlinks                                                                      |
| `links file=<name>`     | List outgoing links                                                                 |
| `outline file=<name>`   | Show headings                                                                       |

### Properties (Frontmatter)

| Command                                    | Description                   |
| ------------------------------------------ | ----------------------------- |
| `property:set name=<k> value=<v> file=<f>` | Set a property                |
| `property:read name=<k> file=<f>`          | Read a property               |
| `property:remove name=<k> file=<f>`        | Remove a property             |
| `properties file=<name>`                   | List all properties on a file |

### Daily Notes & Tasks

| Command                       | Description                      |
| ----------------------------- | -------------------------------- |
| `daily`                       | Open today's daily note          |
| `daily:read`                  | Read daily note contents         |
| `daily:append content=<text>` | Append to daily note             |
| `tasks all`                   | List all tasks in vault          |
| `tasks daily todo`            | Incomplete tasks from daily note |
| `task ref="Note.md:8" toggle` | Toggle a task's completion       |

### Templates

| Command                    | Description                      |
| -------------------------- | -------------------------------- |
| `templates`                | List available templates         |
| `template:read name=<t>`   | Read template content            |
| `template:insert name=<t>` | Insert template into active file |

### Vault Info

| Command           | Description                      |
| ----------------- | -------------------------------- |
| `vault`           | Show vault info                  |
| `vault info=name` | Show just the vault name         |
| `vault info=path` | Show just the vault path         |
| `vaults verbose`  | List all known vaults with paths |

## Best Practices

1. **Vault First**: Before any operation, verify the correct vault with `obsidian vault info=name`. If wrong, prefix commands with `vault=<name>` to target the correct vault.
2. **Ask First & Plan**: Before writing files, ask the user for their preferences regarding **tone**, **structure**, and **verbosity**. Propose a brief plan or preview of the note's structure.
3. **Visual & Rich Content**: Ask the user if they want diagrams (Mermaid), LaTeX, or callouts. Proactively search for relevant, high-quality online images if they would make the note more useful and complete.
4. **Smart Verbosity**: Decide on a verbosity level based on the context, but explicitly ask the user if the scope or level of detail is unclear.
5. **Canvas Design**: Use colors strategically: "1" (Red/Urgent), "3" (Yellow/Idea), "4" (Green/Done), "5" (Blue/Info).
6. **Metadata & Organization**: Always include YAML frontmatter for tags, status, and dates using `property:set` to ensure notes are discoverable and organized.
7. **Rich & Complete**: Aim for high-quality, professional results that leverage Obsidian's full potential to be a "second brain" for the user.
8. **Use `silent` flag**: When creating notes programmatically (e.g., batch operations), use the `silent` flag to avoid switching focus.

## Vault: Check Before Any Operation

**Always verify you are in the correct vault before any operation.**

1. **Before any operation** (create, open, search, etc.): check the current vault with `obsidian vault info=name`.
2. **If the target vault differs** from the user's intended vault: prefix your command with `vault=<name>` (e.g., `obsidian vault="My Vault" create name="Note"`).
3. **Then** run the operation.

Never assume the CLI is already on the right vault. If the user specified a vault or you infer one from context, confirm it matches and use `vault=<name>` when it does not. In the TUI, use `vault:open name=<name>` to switch.

## Technical Constraints

- Paths are relative to vault root.
- Use quotes for values with spaces (e.g., `name="My Note"`).
- Text nodes in canvas support full markdown.
- Canvas colors are strings "1" through "6".
- Don't add comments in .canvas files.
- Obsidian must be running for the CLI to work.
- The CLI uses `file=<name>` (wikilink resolution) or `path=<exact/path.md>` to target files — not positional arguments.

## Additional Resources

- [Official Obsidian CLI Documentation](https://help.obsidian.md/cli) - Full command reference.
- [Obsidian Advanced Syntax](https://help.obsidian.md/advanced-syntax) - Official guide for callouts, highlights, and more.
- [Obsidian Flavored Markdown](https://help.obsidian.md/obsidian-flavored-markdown) - Official documentation for Mermaid, MathJax (LaTeX), and embeds.
- For detailed Canvas JSON structure, see [references/canvas-format.md](references/canvas-format.md)
- For advanced Markdown features (LaTeX, Callouts, Mermaid), see [references/markdown-features.md](references/markdown-features.md)
