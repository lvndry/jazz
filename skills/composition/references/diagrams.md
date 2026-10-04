# Diagrams

Hand-rolled SVG for flow diagrams, systems maps, and state transitions — the
bread and butter of concept explainers. No chart library needed; SVG gives you
the line-draw animation, crisp scaling, and zero network payload.

## Canvas setup

```html
<svg
  viewBox="0 0 900 420"
  role="img"
  aria-label="Flow from A through B to C"
>
  <defs>
    <marker
      id="arrow"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path
        d="M0,0 L10,5 L0,10 z"
        fill="var(--ink-faint)"
      />
    </marker>
  </defs>
  <!-- content -->
</svg>
```

- `viewBox` + `width: 100%` for responsive scaling; never fixed px width.
- `role="img"` + `aria-label` describing the flow; decorative sub-paths get
  `aria-hidden="true"`.
- Arrowheads via `<marker>` on the _path_ (with `marker-end`), so a line-draw
  animation ends with the head appearing with the line.

## Palette in SVG

```css
svg text {
  fill: var(--ink);
  font: inherit;
}
.edge {
  stroke: var(--ink-faint);
  stroke-width: 1.5;
  fill: none;
}
.edge.accent {
  stroke: var(--accent);
}
.node-box {
  fill: var(--surface-2);
  stroke: var(--line);
  rx: 10;
}
.node-label {
  font-size: 13px;
  font-weight: 600;
}
.node-sub {
  fill: var(--ink-muted);
  font-size: 11px;
}
```

The **critical path** (the one the explanation is about) gets `--accent`;
everything else stays `--ink-faint`. One accent path in a diagram is the
strongest way to say "look here."

## Node + edge anatomy

```html
<!-- edge first, node on top -->
<path
  class="edge draw"
  style="--i:0; --len:300"
  d="M180,80 C 260,80 260,80 340,80"
  marker-end="url(#arrow)"
/>
<g
  class="node"
  transform="translate(340,60)"
>
  <rect
    class="node-box"
    width="180"
    height="56"
    rx="10"
  />
  <text
    class="node-label"
    x="16"
    y="24"
    >Build stage</text
  >
  <text
    class="node-sub"
    x="16"
    y="42"
    >~2 minutes</text
  >
</g>
```

Rules:

- Edges connect node **edges**, not centers; stop the path a few px before the
  target so the arrowhead doesn't overlap the box.
- Curves: a single cubic Bézier with horizontal control points
  (`C x1,midY x2,midY endX,endY`) reads as calm; S-curves only for long routes.
- Vertical flow (top→bottom) is the default for processes; horizontal for
  timelines and sequences over time.
- Node boxes: one `rect` + at most two lines of text (label + one sub-line).
  If a node needs more, it belongs in a card beside the diagram, not inside it.

## Line-draw on a diagram

Apply the motion recipe per edge with a visual order:

```html
<path
  class="edge draw"
  style="--i:0; --len:96"
  d="M200,75 L296,75"
  marker-end="url(#arrow)"
/>
<path
  class="edge draw"
  style="--i:1; --len:96"
  d="M488,75 L584,75"
  marker-end="url(#arrow)"
/>
```

**Set `--len` to each path's own geometric length** (straight edge: the
end-to-end distance). Overshoot it and the final dash cycle eats the tip —
the arrowhead never appears in the drawn state. Verify with
`getTotalLength()` in devtools when in doubt.

Nodes appear (staggered `reveal`, or scale-in with
`transform-box: fill-box; transform-origin: center`) _as the incoming edge
lands_: node `i` delay = edge `i` delay + edge duration − 100ms. The whole
diagram reads as being explained step by step.

## State machines

- States = rounded rects (`rx` ≈ half height for pill states is too playful;
  keep `rx: 10`), initial state = filled `--accent-soft` with `--accent-text`
  label.
- Transitions = curved edges with a short label above the midpoint
  (`<text>` + `paint-order: stroke; stroke: var(--bg); stroke-width: 4`
  knocks the label out of the line cleanly).
- Guard conditions in the sub-line, not the main label.

## Hierarchies and trees

- Depth level = one indent, connected by elbow lines (orthogonal, not curves).
- Elbow: `M x1,y1 L x2,y1 L x2,y2` with `stroke-linejoin: round`.
- Level 0–3 maximum; if the tree needs 4+ levels, show level 2 and collapse
  deeper levels behind a `+N` pill (interactive mode).

## Layout heuristics

- Work out coordinates on paper first: a 900-wide viewBox fits 4–5 columns of
  180px nodes comfortably.
- Even gaps: the space between nodes should be consistent; uneven spacing reads
  as accidental.
- Keep ≥ 40px margin around the diagram inside the viewBox.
- Long edge labels: rotate 0°, wrap manually into two `<tspan>`s — never
  rotate text to fit.

## When to NOT hand-roll

- More than ~20 data points on a scatter, or >12 series: inline a real chart
  library (the Chart.js UMD build, CDN in interactive mode) — hand-rolling
  axis math at that scale is where bugs and ugly ticks live.
- Geographical maps: use a simplified pre-made GeoJSON path, not city pins on a
  blank rect.
- Anything the user will edit: a diagram the person tweaks needs data-driven
  rendering (JS building the SVG from a data object), not static coordinates.
