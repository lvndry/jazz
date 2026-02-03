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
   - `obsidian-cli set-default "VaultName"`
   - `obsidian-cli print-default --path-only`
2. **Note Operations**:
   - `obsidian-cli create "Note.md" --content "Content"`
   - `obsidian-cli open "Note.md"`
   - `obsidian-cli search-content "term"`
   - `obsidian-cli fm "Note.md" --edit --key "status" --value "done"`
3. **CLI Help and commands**
 - `obsidian-cli --help`
 - `obsidian-cli [command] --help`

## Best Practices

1. **Ask First & Plan**: Before writing files, ask the user for their preferences regarding **tone**, **structure**, and **verbosity**. Propose a brief plan or preview of the note's structure.
2. **Visual & Rich Content**: Ask the user if they want diagrams (Mermaid), LaTeX, or callouts. Proactively search for relevant, high-quality online images if they would make the note more useful and complete.
3. **Smart Verbosity**: Decide on a verbosity level based on the context, but explicitly ask the user if the scope or level of detail is unclear.
4. **Canvas Design**: Use colors strategically: "1" (Red/Urgent), "3" (Yellow/Idea), "4" (Green/Done), "5" (Blue/Info).
5. **Metadata & Organization**: Always include YAML frontmatter for tags, status, and dates to ensure the note is discoverable and organized.
6. **Rich & Complete**: Aim for high-quality, professional results that leverage Obsidian's full potential to be a "second brain" for the user.

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
