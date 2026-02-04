---
name: obsidian
description: "Operate Obsidian via obsidian-cli to create rich, visual notes with LaTeX, images, colors, callouts, and canvases. Use Obsidian's full potential to embed images, format with markdown, create colored canvas nodes, diagrams, and leverage advanced features. Use when the user mentions Obsidian, obsidian-cli, vaults, notes, or wants rich documentation."
---

# Obsidian CLI

Use `obsidian-cli` (Yakitrak) to manage notes and vaults.

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
   - `obsidian-cli set-default "VaultName"` — switch default vault (use before writing when not in the right vault).
   - `obsidian-cli print-default --path-only` — show current default (use to verify vault before writing).
2. **Note Operations**:
   - `obsidian-cli create "Note.md" --content "Content"`
   - `obsidian-cli open "Note.md"`
   - `obsidian-cli search-content "term"`
   - `obsidian-cli fm "Note.md" --edit --key "status" --value "done"`
3. **CLI Help and commands**
 - `obsidian-cli --help`
 - `obsidian-cli [command] --help`

## Best Practices

1. **Vault First**: Before any operation, check current vault with `print-default`; if wrong, run `obsidian-cli set-default "VaultName"` then proceed.
2. **Ask First & Plan**: Before writing files, ask the user for their preferences regarding **tone**, **structure**, and **verbosity**. Propose a brief plan or preview of the note's structure.
3. **Visual & Rich Content**: Ask the user if they want diagrams (Mermaid), LaTeX, or callouts. Proactively search for relevant, high-quality online images if they would make the note more useful and complete.
4. **Smart Verbosity**: Decide on a verbosity level based on the context, but explicitly ask the user if the scope or level of detail is unclear.
5. **Canvas Design**: Use colors strategically: "1" (Red/Urgent), "3" (Yellow/Idea), "4" (Green/Done), "5" (Blue/Info).
6. **Metadata & Organization**: Always include YAML frontmatter for tags, status, and dates to ensure the note is discoverable and organized.
7. **Rich & Complete**: Aim for high-quality, professional results that leverage Obsidian's full potential to be a "second brain" for the user.

## Vault: Check Before Any Operation

**Always verify you are in the correct vault before any operation.**

1. **Before any operation** (create, open, search, edit, move, delete, fm, etc.): check the current default vault with `obsidian-cli print-default --path-only` (or without `--path-only` to see the vault name).
2. **If the target vault differs** from the user’s intended vault: switch with `obsidian-cli set-default "VaultName"` (use the exact vault name the user wants).
3. **Then** run the operation.

Never assume the CLI is already on the right vault. If the user specified a vault or you infer one from context, confirm it matches the default and call `set-default` when it does not.

## Technical Constraints

- Paths are relative to vault root.
- Use quotes for filenames with spaces.
- Text nodes in canvas support full markdown.
- Canvas colors are strings "1" through "6".
- Don't add comments in .canvas files

## Additional Resources

- [Obsidian Advanced Syntax](https://help.obsidian.md/advanced-syntax) - Official guide for callouts, highlights, and more.
- [Obsidian Flavored Markdown](https://help.obsidian.md/obsidian-flavored-markdown) - Official documentation for Mermaid, MathJax (LaTeX), and embeds.
- For detailed Canvas JSON structure, see [references/canvas-format.md](references/canvas-format.md)
- For advanced Markdown features (LaTeX, Callouts, Mermaid), see [references/markdown-features.md](references/markdown-features.md)
