# Slides & Presentations

Compositions can be decks: a Canva-style presentation is one self-contained
HTML file with a 16:9 canvas, keyboard navigation, and slide-to-slide
transitions. Use this when the person asked for "slides", "a presentation",
"deck", "pitch", or wants to _walk someone through_ something (rather than
leave them something to inspect — that stays a single-page composition).

## Decide deck vs. page

| Signal                                           | Form                                            |
| ------------------------------------------------ | ----------------------------------------------- |
| "present this", "pitch", "walkthrough", "slides" | Deck                                            |
| "explain", "visualise", "cheatsheet", "briefing" | Single page                                     |
| Audience watches _you_ narrate                   | Deck — one idea per slide                       |
| Audience reads it themselves                     | Single page — never force 34 screens of reading |

A deck is a performance: **one idea per slide, the title says it, the visual
proves it.** If a slide needs a caption the audience must read to understand
the slide, the slide is doing two jobs — split it.

## Deck boilerplate

Paste this structure; it includes the design-system tokens (see
`design-system`), 16:9 scaling, navigation, transitions, and URL sync.

```html
<main id="deck">
  <section
    class="slide"
    aria-label="1 of N"
  >
    <h1>Title says the whole point</h1>
    <p class="sub">One supporting line. Optional.</p>
    <!-- one visual: chart, diagram, single big number -->
  </section>
  <section
    class="slide"
    aria-label="2 of N"
  >
    …
  </section>
  <!-- … -->
</main>
```

```css
/* canvas: 16:9, scaled to the viewport from both dimensions */
main#deck {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
}
.slide {
  position: absolute;
  width: min(100vw, 177.78vh); /* 16:9 */
  aspect-ratio: 16 / 9;
  max-height: 100vh;
  padding: 4vmin 5vmin;
  display: flex;
  flex-direction: column;
  justify-content: center;
  visibility: hidden;
  opacity: 0;
  transform: translateX(4%) scale(0.985);
  transition:
    opacity var(--dur-med) var(--ease),
    transform var(--dur-med) var(--ease);
}
.slide.current {
  visibility: visible;
  opacity: 1;
  transform: none;
}
.slide[hidden] {
  display: none;
} /* optional: keep only current in DOM flow */

/* slide typography: display sizes, title carries the idea */
.slide h1 {
  font-size: clamp(1.8rem, 5.2vmin, 3.4rem);
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.12;
  text-wrap: balance;
  margin: 0 0 2vmin;
}
.slide .sub {
  color: var(--ink-muted);
  font-size: clamp(1rem, 2.6vmin, 1.4rem);
  margin: 0;
}
.slide .body {
  color: var(--ink-muted);
  font-size: clamp(0.9rem, 2.1vmin, 1.15rem);
}
.slide .stat-value {
  font-size: clamp(2.6rem, 10vmin, 6rem);
}

/* progress + counter */
#progress {
  position: fixed;
  top: 0;
  left: 0;
  height: 3px;
  width: 0%;
  background: var(--accent);
  z-index: 10;
  transition: width var(--dur-med) var(--ease);
}
#counter {
  position: fixed;
  right: 4vmin;
  bottom: 2.5vmin;
  color: var(--ink-faint);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}
```

```js
const slides = [...document.querySelectorAll(".slide")];
const progress = document.getElementById("progress");
const counter = document.getElementById("counter");
let i = 0;
let vt = null;

function go(n, push = true) {
  n = Math.max(0, Math.min(slides.length - 1, n));
  if (n === i) return;
  slides[i].classList.remove("current");
  i = n;
  const apply = () => {
    slides[i].classList.add("current");
    progress.style.width = ((i + 1) / slides.length) * 100 + "%";
    counter.textContent = `${i + 1} / ${slides.length}`;
    // in-slide choreography re-runs because the class changed
  };
  if (document.startViewTransition && !reducedMotion() && !vt) {
    vt = document.startViewTransition(apply);
    vt.finished
      .catch(() => {})
      .finally(() => {
        vt = null;
      });
  } else {
    // a transition is mid-flight (or unsupported): swap directly, no abort
    vt?.finished?.catch(() => {});
    apply();
  }
  if (push) history.replaceState(null, "", `#${i + 1}`);
}
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

addEventListener("keydown", (e) => {
  if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(e.key)) {
    e.preventDefault();
    go(i + 1);
  } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) {
    e.preventDefault();
    go(i - 1);
  } else if (e.key === "Home") go(0);
  else if (e.key === "End") go(slides.length - 1);
  else if (e.key === "Escape") document.querySelector("[popover]:open")?.hide();
});
addEventListener("click", (e) => {
  if (e.target.closest("button, a, input, [popover]")) return;
  // right 30% advances, left 30% goes back, middle does nothing
  const x = e.clientX / innerWidth;
  if (x > 0.7) go(i + 1);
  else if (x < 0.3) go(i - 1);
});
addEventListener("touchend", (e) => {
  const t = e.changedTouches[0];
  const x = t.clientX / innerWidth;
  if (x > 0.65) go(i + 1);
  else if (x < 0.35) go(i - 1);
});

// deep link: open at #n
const hash = parseInt(location.hash.slice(1), 10);
go(Number.isFinite(hash) ? hash - 1 : 0, false);
// chrome init for the landing slide (go() skips no-op moves)
progress.style.width = ((i + 1) / slides.length) * 100 + "%";
counter.textContent = `${i + 1} / ${slides.length}`;
```

Add `<div id="progress"></div><div id="counter" aria-hidden="true"></div>`
before `</main>`.

## Slide layout rules

- **8-column mental grid** inside the slide's `padding`: title spans full
  width, visuals span 5–6 columns. Consistent `padding: 4vmin 5vmin` on every
  slide gives free visual rhythm.
- **One accent per deck**, from the design system; the accent marks the
  current idea on each slide (a highlighted number, the critical path in a
  diagram), never a rainbow of chart colors.
- Slide types worth supporting, in this order of usefulness:
  1. **Title slide** — statement + optional one-line context. No logos, no
     "hello".
  2. **One big number** — `stat-value` + label + source line. The most
     persuasive slide type; use it early.
  3. **One diagram or chart** — line-draw on entry (`motion` reference),
     title states the takeaway ("Churn doubled in Q2", not "Churn").
  4. **Two-column contrast** — before/after, option A/B, with the
     recommendation in `--accent-text`.
  5. **Quote / evidence** — big text, source in `--ink-faint`.
  6. **Closing** — the single ask or next step, nothing else.
- Source lines: small, `--ink-faint`, bottom-left, on every slide with data.

## Transitions

- **Default:** the 4% slide + fade above. Simple, calm, works everywhere.
- **Upgrade:** View Transitions (in the boilerplate) morphs the swap. With a
  single `view-transition-name` on an element that _persists_ across two
  slides (e.g. a brand mark, or the same chart being re-scoped), the browser
  morphs it between layouts — that's the premium Canva-style effect. Feature
  detect; fallback is the plain fade.
- **In-slide choreography:** when a slide becomes `.current`, re-run its
  reveals. Give in-slide elements `.slide .reveal` with the same staggered
  recipe as `motion`, but reset the animation on entry:

```css
.slide .reveal {
  opacity: 0;
}
.slide.current .reveal {
  animation: reveal-in 450ms var(--ease) forwards;
  animation-delay: calc(var(--i, 0) * 70ms);
}
```

- **Never** bounce, rotate-in-from-90°, or curtain-wipe. A deck should feel
  like it was _edited_, not _assembled_.

## Speaker notes

`<details class="notes">` per slide is the offline-friendly pattern:

```html
<details class="notes">
  <summary aria-label="Speaker notes">Notes</summary>
  <p>What to say, timing, the awkward number to explain…</p>
</details>
```

```css
.notes {
  position: absolute;
  bottom: 1.5vmin;
  left: 5vmin;
  font-size: 0.75rem;
  color: var(--ink-faint);
}
.notes summary {
  cursor: pointer;
  list-style: none;
}
```

Or a `popover` opened with `N`. Notes must never be visible by default.

## Static mode for decks

Static mode screenshots one viewport — a deck is inherently multi-page, so:

- The **default slide must be the best one** (usually the title or the big
  number), rendered fully by the screenshot (≤800ms budget, `motion` ref).
- Set a `print` stylesheet that stacks all slides:

```css
@media print {
  main#deck {
    position: static;
    display: block;
  }
  .slide {
    position: relative;
    visibility: visible;
    opacity: 1;
    transform: none;
    width: 100%;
    page-break-after: always;
  }
  #progress,
  #counter,
  .notes {
    display: none;
  }
}
```

- Say in the reply that `#3` deep-links to slide 3, and that printing
  produces one slide per page.

## Anti-patterns

- A slide with more than ~30 words of body text — that's a document, not a deck.
- Bullet lists as the primary visual. Convert to one number, one diagram, or
  a two-column contrast; bullets are for the speaker notes.
- Animated background blobs on every slide — motion belongs to data entry and
  slide transitions.
- Navigation UI (arrows, dots) larger than the content. A 3px progress line and
  a tabular-nums counter are the whole chrome.
- Auto-advancing slides. The presenter controls pace.
- Embedding a custom font per slide — one optional display font for `h1`
  across the deck (design system rule), base64 inlined.
