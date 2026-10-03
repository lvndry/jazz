# Design System

The house style for every composition. Load this for every artifact and start
the document with the token boilerplate below.

## Design direction

**Editorial, quiet, confident.** Generous whitespace, one accent color,
restrained gradients. Typography does the hierarchy — no boxes for the sake of
boxes. Motion is choreography, not decoration. A composition should feel like
it was set by a typesetter, not assembled from dashboard components.

- **One accent per composition.** Everything else is neutral. Derive tints,
  hovers, and chart secondary series from the accent with `color-mix()`; never
  pick a second hue ad hoc.
- **Type first.** A well-set headline and a confident large number beat a
  decorated card. Let size, weight, and whitespace carry hierarchy.
- **Restraint is the aesthetic.** If two elements both have shadows or
  gradients, remove one.
- **Dark by default, light on request.** Dark surfaces make data and accent
  colors pop and read as premium; use the light scheme only when the person
  asks or the context is a printed-style document.

## Token boilerplate

Paste this as the first block of the `<style>` element, then set only
`--accent` (one HSL hue value) per composition. Everything else follows.

```css
:root {
  color-scheme: dark; /* or light — makes form controls and scrollbars match */
  /* Pick ONE accent per composition. Examples:
     indigo  240 / 75% / 72%  |  amber  40 / 95% / 62%
     emerald 158 / 64% / 48%  |  rose    348 / 78% / 66% */
  --accent-h: 240;
  --accent-s: 75%;
  --accent-l: 72%;

  --accent: hsl(var(--accent-h) var(--accent-s) var(--accent-l));
  --accent-strong: hsl(var(--accent-h) var(--accent-s) calc(var(--accent-l) - 12%));
  --accent-soft: hsl(var(--accent-h) var(--accent-s) calc(var(--accent-l) + 8%) / 0.14);
  --accent-text: hsl(var(--accent-h) var(--accent-s) calc(var(--accent-l) + 10%));

  /* Neutrals — dark scheme */
  --bg: hsl(230 16% 8%);
  --surface: hsl(230 14% 12%);
  --surface-2: hsl(230 12% 17%);
  --ink: hsl(228 14% 93%);
  --ink-muted: hsl(230 9% 62%);
  --ink-faint: hsl(230 9% 42%);
  --line: hsl(230 11% 22%);

  /* Shape, depth, motion */
  --radius: 12px;
  --radius-sm: 8px;
  --shadow-1: 0 1px 2px hsl(0 0% 0% / 0.3);
  --shadow-2: 0 8px 24px hsl(0 0% 0% / 0.35);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dur-fast: 150ms;
  --dur-med: 300ms;
  --dur-slow: 600ms;

  /* Spacing scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --space-5: 40px;
  --space-6: 64px;
}
```

For a **light** composition, swap the neutral block to:

```css
--bg: hsl(230 20% 98%);
--surface: hsl(0 0% 100%);
--surface-2: hsl(230 16% 95%);
--ink: hsl(230 22% 14%);
--ink-muted: hsl(230 9% 42%);
--ink-faint: hsl(230 9% 62%);
--line: hsl(230 14% 88%);
--shadow-1: 0 1px 2px hsl(230 20% 20% / 0.08);
--shadow-2: 0 8px 24px hsl(230 20% 20% / 0.12);
```

Chart **series** beyond the accent are derived, never invented:

```css
--series-2: hsl(var(--accent-h) calc(var(--accent-s) - 25%) calc(var(--accent-l) - 22%));
--series-3: hsl(calc(var(--accent-h) + 20) var(--accent-s) calc(var(--accent-l) + 14%));
```

## Base document

```css
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    "Helvetica Neue",
    Arial,
    sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
main {
  max-width: 960px;
  margin: 0 auto;
  padding: var(--space-5) var(--space-4) var(--space-6);
}
h1,
h2,
h3 {
  line-height: 1.2;
  text-wrap: balance;
}
h1 {
  font-size: clamp(1.75rem, 1.2rem + 2.5vw, 2.75rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 var(--space-2);
}
.subtitle {
  color: var(--ink-muted);
  font-size: clamp(1rem, 0.9rem + 0.5vw, 1.15rem);
  margin: 0 0 var(--space-5);
}
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-4);
  box-shadow: var(--shadow-1);
}
/* Numbers that align in columns, tables, and stats */
.num {
  font-variant-numeric: tabular-nums;
}
/* Big headline number */
.stat-value {
  font-size: clamp(2.5rem, 2rem + 3vw, 4rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  color: var(--ink-muted);
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

## Typography rules

- System stacks only, unless the piece wants a distinctive voice: then embed
  **one** small display font (a single woff2, ~30–50 KB, base64 `@font-face`)
  for the `h1` only. Never embed more than one custom font file.
- `font-variant-numeric: tabular-nums` on any number that aligns with others.
- `text-wrap: balance` on headings, `text-wrap: pretty` on prose paragraphs.
- Fluid scale with `clamp()`; never fixed px sizes for body text.
- Units sit next to values ("€1,240 / mo"), ranges get explicit bounds.
- Keep labels short. A chart label over ~12 words belongs in a caption, not a
  tick.

## Layout rules

- Mobile-first. Must remain usable at 320px: stack rather than squeeze.
- `max-width: 960px` on `main` is the default; dashboards may go to 1200px with
  a CSS grid of `1fr` columns that collapse to one under 720px.
- Separate ideas with whitespace (`var(--space-4)` minimum), not with rules
  and boxes. Use a `border-top: 1px solid var(--line)` only to divide an
  information-dense card.
- One dominant element per screen. If two sections fight, the second goes
  below the fold or into a control.

## Color rules

- Background, surface, accent, and two neutrals for text. That is the whole
  palette.
- Accent is for: the primary data series, the primary action, the takeaway
  highlight. No more.
- Status colors (success/warn/danger) are the only allowed off-palette hues,
  used sparsely, and always paired with an icon or text — never color alone.
- Contrast: ink on surface must clear 4.5:1; large display numbers 3:1.
- On dark: accents get lightened (`--accent-text`), never raw. On light:
  accents may darken.

## Anti-patterns

- One color per element ("rainbow chart") — derive series from the accent.
- `transition: all` — name the properties.
- Shadows AND heavy borders AND gradient cards on the same element.
- Animated blobs, aurora gradients, glassmorphism stacked on glassmorphism.
- A dashboard grid of equal cards when one strong view answers the question.
- Decorative 3D, pie slices over 5, or a donut with 12 segments.
- Rounded-corner radius larger than the card's purpose: `--radius` for cards,
  `--radius-sm` for inputs, full-pill only for tags and toggles.
