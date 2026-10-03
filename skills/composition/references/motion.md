# Motion

Named animation recipes for compositions. Pick by what the artifact is doing;
compose freely, but every animation in a piece must share the same easing and
duration family (the tokens from the design system) so the motion reads as one
choreography.

## Ground rules

- **Motion explains, never decorates.** If removing an animation loses no
  information, keep it only if it's subtle (≤ 200ms) and quiet.
- **Animate only `transform`, `opacity`, `filter`, and (for SVG) `stroke-dashoffset`.**
  Never `width`/`height`/`top`/`left`/`margin` — they trigger layout and jank.
  (Sizing a bar chart? animate `transform: scaleY()` with `transform-origin: bottom`.)
- **Durations:** 150ms micro (hover, press), 300ms standard (reveal, expand),
  600ms max (line-draw, large transitions). Anything longer is a video, not UI.
- **One easing token:** `var(--ease)` everywhere. Never ease-in (it reads as
  heavy); never linear except for progress indicators.
- **Always honor reduced motion** — wrap every recipe that is visible motion:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- **Content never depends on motion.** Every state is fully readable with

## The static-mode trap (read first)

In `static` mode the page is screenshotted by headless Chromium once it is
"idle" (`networkidle0`). A fully self-contained file has **no network to wait
for, so the shot can be taken almost immediately after load** — before a
staggered reveal has finished. Even worse, in a virtual-time rendering context
the screenshot can land while animations are still in flight, freezing cards at
40% opacity in the "final" PNG.

Verified behavior: a ~1s staggered sequence rendered complete with a generous
wait (≥5s), but was caught mid-flight at ~1s.

Rules for static mode:

1. **Total entrance budget: ≤ 800ms**, or skip animations entirely.
2. If you keep them: short durations (300–450ms), small stagger (≤ 60ms),
   and no line-draws over 500ms.
3. **Interactive mode gets the full choreography** — the page opens live in a
   real browser where the person actually watches it.

A static PNG that is instantly legible beats an animated one captured at 40%
opacity. When in doubt, ship static mode without entrance animation:

## Recipe: staggered reveal (page load)

The single highest-impact recipe. Nothing appears all at once; elements cascade
in by 60–80ms.

```css
.reveal {
  opacity: 0;
  transform: translateY(12px);
  animation: reveal-in 450ms var(--ease) forwards;
  animation-delay: calc(var(--i, 0) * 70ms);
}
@keyframes reveal-in {
  to {
    opacity: 1;
    transform: none;
  }
}
```

```html
<h1
  class="reveal"
  style="--i:0"
>
  Title
</h1>
<p
  class="subtitle reveal"
  style="--i:1"
>
  Subtitle
</p>
<section
  class="card reveal"
  style="--i:2"
>
  Primary chart
</section>
<section
  class="reveal"
  style="--i:3"
>
  Detail
</section>
```

`--i` is the visual order, not the DOM order. Cap the stagger at ~10 items —
past that, total delay exceeds the static-mode budget.

## Recipe: line-draw (SVG diagrams and charts)

The signature move for flow diagrams and concept explainers: paths trace
themselves in like a whiteboard.

```css
.draw {
  stroke-dasharray: var(--len, 1000);
  stroke-dashoffset: var(--len, 1000);
  animation: draw-in 900ms var(--ease) forwards;
  animation-delay: calc(var(--i, 0) * 200ms);
}
@keyframes draw-in {
  to {
    stroke-dashoffset: 0;
  }
}
```

Set `--len` to each path's real length (slightly oversized is fine, but set a
per-element value rather than one huge shared number, or draw speed varies
weirdly between short and long paths). For a chart that should draw in one
sweep, one shared length works. Labels ride along with a staggered `reveal`
delay timed to when the line reaches them.

**Static mode:** a line-draw takes 900ms+, so in static mode either shorten to
≤600ms with no stagger, or skip it and render the full path.

## Recipe: bar grow

Bars scaleY from zero; origin at the base. Stagger left-to-right.

```css
.bar {
  transform: scaleY(0);
  transform-origin: bottom;
  animation: grow 500ms var(--ease) forwards;
  animation-delay: calc(var(--i, 0) * 60ms);
}
@keyframes grow {
  to {
    transform: scaleY(1);
  }
}
/* horizontal bars: transform-origin: left; scaleX instead */
```

Value labels fade in _after_ their bar lands (delay = bar delay + 400ms).

## Recipe: count-up (headline stats)

rAF counter on load. 800–1200ms, ease-out curve, format with the real
precision (never invent decimals).

```js
function countUp(el, target, { duration = 1000, format = (n) => n.toLocaleString() } = {}) {
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  (function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(target * ease(t));
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}
```

Reduced motion: set the final value immediately (check
`matchMedia("(prefers-reduced-motion: reduce)")`). **Static mode:** run with
`duration: 500` or skip entirely.

## Recipe: enter/exit (@starting-style)

For accordions, popovers, detail panels that open and close. `@starting-style`
lets a transition _enter_ too, not just leave.

```css
.panel {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity var(--dur-med) var(--ease),
    transform var(--dur-med) var(--ease);
}
.panel[hidden] {
  opacity: 0;
  transform: translateY(-6px);
}
@starting-style {
  .panel:not([hidden]) {
    opacity: 0;
    transform: translateY(-6px);
  }
}
```

Height: transition `grid-template-rows: 0fr → 1fr` on a wrapper (with the child
at `min-height: 0`) for smooth expand/collapse without measuring in JS.

## Recipe: hover lift

Cards, rows, and buttons that respond to presence.

```css
.lift {
  transition:
    transform var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.lift:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
}
.lift:active {
  transform: translateY(0);
}
```

## Recipe: value pulse (live updates)

When a value changes in an interactive piece, acknowledge the change with a
short pulse — the user knows the number moved without scanning.

```css
.pulse {
  animation: none;
}
.pulse.changed {
  animation: pulse 400ms var(--ease);
}
@keyframes pulse {
  0% {
    opacity: 1;
  }
  30% {
    opacity: 0.35;
    transform: scale(0.98);
  }
  100% {
    opacity: 1;
    transform: none;
  }
}
```

```js
el.textContent = next;
el.classList.remove("changed");
void el.offsetWidth; // restart the animation
el.classList.add("changed");
```

## Recipe: view transitions (tab and step switching)

For interactive pieces with tabs or step navigation, View Transitions morphs
the old screen into the new instead of blinking. Feature-detect; the fallback
is an instant swap, which is fine.

```js
async function switchView(name) {
  const apply = () => renderView(name);
  if (document.startViewTransition) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}
```

```css
/* Named views get a real morph; unnamed ones crossfade */
.named {
  view-transition-name: view;
}
::view-transition-old(view),
::view-transition-new(view) {
  animation-duration: var(--dur-med);
  animation-timing-function: var(--ease);
}
```

One `view-transition-name` per document — scope it to the single element that
swaps.

## Recipe: scroll-driven (long briefings only)

Scroll-linked progress bar and section reveals. Degrades to static on
unsupported browsers — acceptable since content doesn't depend on it.

```css
@supports (animation-timeline: scroll()) {
  .scroll-progress {
    transform-origin: left;
    animation: grow-x linear both;
    animation-timeline: scroll();
  }
  @keyframes grow-x {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }

  .section {
    animation: reveal-in both;
    animation-timeline: view();
    animation-range: entry 0% entry 40%;
  }
}
```

Skip scroll-driven entirely in static mode.

## Sequencing a page

A well-choreographed load, in order: title (0ms) → subtitle (70ms) → primary
visual (140ms) → supporting elements (210ms+). The **primary signal is never
last.** If the artifact has more than one animation system (reveal + line-draw

- count-up), start them from the same timeline so the piece feels directed:

* 0–150ms: header
* 150–1000ms: primary visual (line-draw or bar grow)
* 400ms+: secondary stats (count-up starts as the chart lands)

Total: under 1.2s for the full interactive load; under 800ms for static.

## Anti-patterns

- `transition: all` — name your properties.
- Bounce/elastic easing on data. Bounce is for toys, not numbers.
- Animating on scroll-into-view with JS IntersectionObserver when
  `animation-timeline: view()` does it for free.
- Infinite ambient animations (pulsing dots, floating blobs) behind content.
- Motion faster than 100ms — the eye can't track it.
- Two different easings in one piece.
