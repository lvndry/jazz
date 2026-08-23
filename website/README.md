# Jazz website

The marketing site and docs renderer for Jazz. Astro 5 + Bun, static output.

Two rules keep it honest:

- **The repo is the CMS.** Docs pages render `../docs/**/*.md` directly —
  never copy content into this package.
- **Tokens are generated.** `bun run tokens` reads `src/cli/ui/theme.ts` and
  `src/cli/ui/glyphs.ts` and writes `src/styles/tokens.css` +
  `src/generated/tokens.ts`. CI fails if the checked-in output is stale.
  Root dependencies must be installed (`bun install` at the repo root) for
  the generator to resolve the theme's imports.

```bash
bun install        # in website/
bun run dev        # local dev server
bun run build      # tokens + astro build → dist/
```

Design direction and phase plan: `docs/superpowers/plans/website.md`
(local-only). Marketing pages pin `data-skin="dark"`; docs pages follow the
viewer's preference.
