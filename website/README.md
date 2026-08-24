# Jazz website

The marketing site and docs renderer for Jazz. Astro 5 + Bun, static output.

Three rules keep it honest:

- **Docs stay in the repo.** Pages render `../docs/**/*.md` directly —
  never copy docs into this package. Contributors, the CLI, and the site
  all read the same files. `docs/superpowers/` and `docs/plans/` stay off
  the site.
- **Blog posts live here.** `src/content/blog/**/*.md` is site-only
  content. Do not put posts at the repo root.
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
