---
name: defuddle
description: Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use instead of WebFetch when the user provides a URL to read or analyze, for online documentation, articles, blog posts, or any standard web page.
---

# Defuddle

Use Defuddle CLI to extract clean readable content from web pages. Prefer over WebFetch for standard web pages — it removes navigation, ads, and clutter, reducing token usage.

Use `npx defuddle-cli` by default. Install globally only if already available or asked by user `npm install -g defuddle-cli`

## Usage

Always use `--md` for markdown output:

```bash
npx defuddle-cli parse <url> --md
```

Save to file:

```bash
npx defuddle-cli parse <url> --md -o content.md
```

Extract specific metadata:

```bash
npx defuddle-cli parse <url> -p title
npx defuddle-cli parse <url> -p description
npx defuddle-cli parse <url> -p domain
```

## Output formats

| Flag        | Format                           |
| ----------- | -------------------------------- |
| `--md`      | Markdown (default choice)        |
| `--json`    | JSON with both HTML and markdown |
| (none)      | HTML                             |
| `-p <name>` | Specific metadata property       |
