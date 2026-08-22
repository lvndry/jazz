# Interface Design

The visual language of the Jazz terminal interface: one mark, one accent, six
hues, and the rules that decide every case not covered explicitly.

Jazz is a conversation, not an instrument panel. The answer is the point and
everything else is apparatus, so the design is measured against legibility
rather than density.

The tables below are generated from the modules that define them — run
`bun run docs:design` after changing [`theme.ts`](../../src/cli/ui/theme.ts) or
[`glyphs.ts`](../../src/cli/ui/glyphs.ts). A design document that restates hex
values by hand starts drifting the first time someone tunes a colour, and a
drifted design doc is worse than none.

---

## What is shipped, and what is specified

This document covers both, and says which is which.

**Shipped.** The fullscreen single-column layout, live zone, approval card,
renderer-neutral prompts, in-app history search, both palettes, and the glyph and
emphasis rules are in the code and under test. Unsupported terminals use the
append-only interface; an OpenTUI startup failure or an Ink-only workflow hands
the session to the complete legacy interface rather than leaving an inert frame.

**Still staged.** Search finds and browses persisted session matches, but does
not yet reopen a selected historical session. Copy-out and the command palette
are intentionally absent from the key legend until their actions exist.

---

## The two laws

### Colour is semantics

Every hue answers the question *"what is this?"* — who is speaking, is this a
tool, did it work, should I worry, is this about to touch my real accounts. That
is six questions, so six hues. Everything else — headings, rules, borders,
labels, timestamps, paths — lives on the neutral ramp.

Six is a set you can hold in your head, which is the point: after an hour in the
app you read colour without deciding to.

Two consequences worth stating, because both were bugs before:

- **Emphasis is not a hue.** Bold text, headings and table chrome get weight,
  not colour. Emphasis does not answer "what is this?", and the accent means
  *live* everywhere else, so spending it on bold prose would actively mislead.
  Hierarchy comes from stroke weight (`▏▎▍▌`), rule weight (`─ ━`), shade
  density (`░▒▓█`), and indentation.
- **There is one accent.** Who is speaking is carried by the marker glyph, not
  by giving each party its own colour. Previously brand, warning and inline code
  were all the same amber, so a bulleted list with bold text and a code span
  rendered as a wall of orange.

### Motion is allowed where text is not

While the model is silent the interface may move — that is the one moment when
motion is pure information. The instant a token lands, everything except the
status line goes still, and the only thing changing in the frame is the sentence
being read.

Animation runs at roughly 6 frames per second, and is replaced rather than merely
slowed when there is no TTY: a spinner written to a pipe produces thousands of
junk frames, so headless emits one line per state transition instead.

---

## Identity

The mark is `▞` (U+259E). Two filled squares offset off the grid: syncopation,
which is the actual musical content of jazz, rather than a picture of a musical
note. The ascending diagonal is also the stroke of a **z**.

It is chosen for three measurable properties as much as for its shape:

- **Block Elements is one of only two Unicode ranges with full coverage** in
  Menlo, SF Mono, Consolas, DejaVu Sans Mono and JetBrains Mono.
- It is East-Asian **Neutral**, so it occupies exactly one column in every
  terminal and every locale.
- Modern terminals draw that range **procedurally**, as exact rectangles rather
  than font glyphs, so it tiles seamlessly at any size.

The same range generates the family: `▞▚` for call and response, `▖▘▝` for an
ensemble, `▙▚▖` for a lead voice with the section behind it.

### Wordmark

```text
▄▀▀▄▀▄▄▀▀▄▄▀▄▀▀▄▀▀▄▀▄▄▀▀▄▄▀▄▀▀▄▀▀▄▀▄▄▀▀▄
▞  jazz
   One agent. Every surface. Your rules.
```

The ornament is not decoration and not the name spelled a second time. Upper
half-cells and lower half-cells are two independent rhythmic voices sharing one
line of text — a five-cell figure against a three-cell one, so the pattern never
settles into a square loop.

---

## Glyphs

Two things decide whether a glyph is safe, and both were measured rather than
assumed. **Coverage**, from the `cmap` tables of the fonts people actually use:

| Block | Menlo | SF Mono | Courier |
| --- | --- | --- | --- |
| Box Drawing U+2500–257F | 128/128 | **128/128** | 0/128 |
| Block Elements U+2580–259F | 32/32 | **32/32** | 0/32 |
| Geometric Shapes U+25A0–25FF | 96/96 | **14/96** | 1/96 |
| Arrows U+2190–21FF | 112/112 | **11/112** | 0/112 |
| Misc Technical U+2300–23FF | 117/256 | **7/256** | 0/256 |
| Misc Symbols U+2600–26FF | 149/256 | **0/256** | 1/256 |
| Dingbats U+2700–27BF | 144/192 | **15/192** | 0/192 |
| Braille U+2800–28FF | **0/256** | **0/256** | **0/256** |

And **width**, from Unicode's East Asian Width data: an *Ambiguous* glyph
occupies two columns in a CJK-width locale and one everywhere else, so it
silently doubles its footprint.

Three consequences drive every choice:

1. Box Drawing and Block Elements are the only ranges with full coverage
   everywhere. Dingbats (`✓ ✗ ❯`), Geometric Shapes (`◆ ◐ ● ○`), Arrows and
   Misc Symbols (`♪`) are not safe — SF Mono, the default macOS coding font, is
   missing most of them and substitutes a fallback at a mismatched advance width.
2. **Braille has zero coverage in every target font.** Only DejaVu ships it, so
   every braille spinner in the ecosystem is drawn by fallback — which is where
   the familiar right-hand gap comes from.
3. Within Block Elements the *quadrants* (`▖▗▘▝▚▞▙▛▜▟`) plus `▐ ░` are
   East-Asian Neutral: exactly one column in every locale. The eighth-block
   ladder and shading are Ambiguous, so they appear only where nothing aligns
   beneath them.

Status marks are Box Drawing stubs, so they read as weight rather than as
pictograms: `╺` is heavier than `╴`, which is the distinction being drawn anyway.

<!-- generated:glyphs -->
| Glyph | ASCII | Meaning |
| --- | --- | --- |
| `▞` | `*` | the mark |
| `»` | `>` | you are speaking |
| `╶` | `-` | the agent is speaking |
| `▐` | `\|` | the agent is asking for authority |
| `╺` | `+` | a tool succeeded |
| `╻` | `x` | a tool failed |
| `╵` | `!` | needs attention, not broken |
| `╴` | `o` | not started |
| `╺` | `*` | connected and live |
| `╹` | `+` | a delegated lane closing |
| `▎` | `\|` | speaker rail |
| `▏` | `:` | one level deeper |
| `▏` | `>` | quoted or subordinate text |
| `∙` | `*` | list item |
| `─` | `-` | rule |
| `━` | `=` | heavy rule, and the filled run of a meter |
| `█` | `#` | context used |
| `░` | `.` | context free |
<!-- /generated:glyphs -->

`src/cli/ui/glyphs.test.ts` enforces this: every character in the Unicode set
must come from a verified-safe range, and the glyphs that were previously
shipping from unsafe ranges are named so they cannot return.

---

## The activity indicator

Five lanes, each resting and then playing a three-step burst on its own period.

The point is that it can **count**. A generalist agent's characteristic state is
several things in flight at once — reaching into a mailbox, a search and a
calendar simultaneously — and a single rotating glyph cannot express that. A
longer period means a longer rest, so the number of moving lanes tracks how much
work is actually happening.

<!-- generated:indicator -->
| Property | Value |
| --- | --- |
| Lane periods | 3, 4, 5, 7, 11 frames |
| Burst | `▖▚▘` — opening, live, closing |
| At rest | `░` |
| Cycle before repeating | 4620 frames, about 13 minutes at 170ms |
<!-- /generated:indicator -->

The periods are pairwise coprime, which matters: a previous version used 4, 6, 3,
4, 6, so the composite looped every 12 frames — about two seconds — and the two
pairs of equal periods were locked together permanently.

Two properties hold for every frame, and both are guaranteed by using periodic
oscillators rather than a cellular automaton: no frame is ever entirely at rest,
and full alignment of all five lanes happens in 3 frames out of 4620. An activity
indicator that can appear frozen is broken.

---

## Palette

Every value has an exact xterm-256 index. The accent is index 45 exactly, so it
is byte-identical over SSH rather than approximated by a downgrade.

<!-- generated:palette-dark -->
| Token | dark | Role |
| --- | --- | --- |
| `canvas` | `#0B0D10` | the window's own ground |
| `primary` | `#00D7FF` | live, and your own affordances |
| `agent` | `#00D7FF` | live agent identity — the same accent, because the glyph says who |
| `accentDim` | `#00AFD7` | subordinate live content, links, citations |
| `link` | `#00AFD7` |  |
| `success` | `#5FD787` | it worked |
| `error` | `#FF6B6B` | it broke |
| `warning` | `#D7AF5F` | a scope worth noticing |
| `info` | `#A9B2BD` | on the neutral ramp — info is not a hue |
| `selected` | `#E8EBEF` | primary text |
| `prompt` | `#00D7FF` |  |
| `secondary` | `#A9B2BD` | secondary text |
| `muted` | `#5C6673` | metadata, settled receipts, timestamps |
| `reasoning` | `#00AFD7` | live, but subordinate to an answer |
| `toolBorder` | `#22272E` |  |
| `surface` | `#14171B` |  |
| `surfaceSoft` | `#14171B` |  |
| `surfaceStrong` | `#22272E` |  |
| `border` | `#22272E` |  |
| `borderSoft` | `#22272E` |  |
| `syntaxStructure` | `#9B8CFF` | keywords and structure |
| `syntaxValue` | `#D787AF` | strings, numbers, and inline code |
| `syntaxType` | `#92B4C8` | types and constructors |
<!-- /generated:palette-dark -->

The light palette is not an inversion. The accent has to carry real contrast
against paper, so cyan darkens to a teal that still reads as the same role, and
the syntax tints are re-chosen rather than merely darkened — on paper they have
to separate by hue rather than by lightness.

<!-- generated:palette-light -->
| Token | light | Role |
| --- | --- | --- |
| `canvas` | `#FBFCFD` | the window's own ground |
| `primary` | `#00718F` | live, and your own affordances |
| `agent` | `#00718F` | live agent identity — the same accent, because the glyph says who |
| `accentDim` | `#005F87` | subordinate live content, links, citations |
| `link` | `#005F87` |  |
| `success` | `#116B3E` | it worked |
| `error` | `#B3261E` | it broke |
| `warning` | `#8A5F00` | a scope worth noticing |
| `info` | `#4A525E` | on the neutral ramp — info is not a hue |
| `selected` | `#12151A` | primary text |
| `prompt` | `#00718F` |  |
| `secondary` | `#4A525E` | secondary text |
| `muted` | `#767F8C` | metadata, settled receipts, timestamps |
| `reasoning` | `#005F87` | live, but subordinate to an answer |
| `toolBorder` | `#D9DEE5` |  |
| `surface` | `#F1F3F6` |  |
| `surfaceSoft` | `#F1F3F6` |  |
| `surfaceStrong` | `#D9DEE5` |  |
| `border` | `#D9DEE5` |  |
| `borderSoft` | `#D9DEE5` |  |
| `syntaxStructure` | `#5B3FBF` | keywords and structure |
| `syntaxValue` | `#9B2C6F` | strings, numbers, and inline code |
| `syntaxType` | `#2F6690` | types and constructors |
<!-- /generated:palette-light -->

`src/cli/ui/theme.test.ts` asserts contrast against the canvas, perceptual
distance between roles that must never be confused, and that the accent sits on
an exact cube vertex. It forces truecolor to do so, because the rest of the suite
runs with colour disabled, which makes ordinary colour assertions vacuous.

---

## Layout

```text
┌────────────────────────────────────────────┐
│ header   identity · model · apps · context │
├────────────────────────────────────────────┤
│                                            │
│     the conversation, full width           │
│     prose tracks the terminal              │
│                                            │
├────────────────────────────────────────────┤
│ live zone   what is running right now      │
├────────────────────────────────────────────┤
│ input                                      │
├────────────────────────────────────────────┤
│ footer    mode · keys · cost · elapsed     │
└────────────────────────────────────────────┘
```

[**interface.html**](./interface.html) renders the specified design in full colour —
the session, approval, subagents, reasoning and search screens, plus an 80-column
variant, with the activity indicator animating. Open it in a browser; GitHub shows
HTML files as source rather than rendering them.

One column at every width. No sidebar, and no breakpoint at which one appears —
which also removes the collapse behaviour, the two-column reflow, and every
"sidebar hidden" variant.

**The live zone** is a bounded region pinned directly above the input, holding
one row per tool in flight plus the current step of any multi-step task. It is
always in the same place, so "what is jazz doing right now" has exactly one place
to look — and it sits against the input, where the eye already is. The input and
footer are anchored to the bottom, so the zone grows *upward* and the
conversation yields the rows; typing never moves under your hands.

**The measure.** The transcript is the width of the terminal. Running text
takes that content column (minus the rail and a two-column right margin); a
short flush-right strip holds timestamps and lane labels once the frame is
wide enough that they would otherwise sit on the sentence. Tool output,
entity lists, tables and code fences take the same full content width,
because those are scanned rather than read.

---

## The approval card

A coding agent asks permission to edit a file you can revert. Jazz asks
permission to send an email, write to a calendar, or post in a channel other
people read. There is no undo, so this is the most consequential component in the
product.

| Rule | Why |
| --- | --- |
| It is a different class of object | Whatever the visual language is, this block breaks it in one deliberate way. It must never look like another log line |
| It names the real account, verbatim | Not "your calendar" — the actual address. The trust argument is that Jazz always says which real-world object is in scope |
| Every resulting field, before you commit | Title, exact time with timezone, every attendee, which calendar. Nothing discoverable only after pressing enter |
| Irreversibility stated in prose | A sentence, not an icon |
| It reads as a decision, not a fault | Red belongs to things that already broke; colouring a choice like an error teaches people to dismiss errors |
| It animates in, then holds perfectly still | Persistent motion reads as pressure, and pressure on an irreversible choice is a dark pattern |
| Controls sit outside the data frame | The card is what will happen; the line beneath is what you can do |
| Reject is as available as accept | Hiding the alternative is how consent theatre works |
| "Always allow" is the least attractive thing on screen | The irreversible convenience option should be findable, never inviting |
| A distinct glyph for asking versus speaking | `▐` asking, `╶` speaking — one codepoint carrying a real semantic distinction |
| On failure, say what did *not* happen | Silence about state destroys trust, and auth failure is this product's characteristic error |

Two of these are safety requirements rather than aesthetics. The card opens in a
deny-only state for 250ms, so buffered Enter and always-allow keys are discarded
while Escape remains immediate. Rejection removes the approval card before the
optional guidance prompt appears, and every action field remains available in a
scrolling record rather than being truncated.

---

## Reach

### Any 256-color terminal, over SSH

Both accents sit on real xterm cube vertices, so they are byte-identical over a
link rather than approximated. No truecolor is required for anything. Every glyph
is single-width in every locale, so a frame that lines up locally lines up on a
server with a different `LANG`. Animation is quantised to whole cells and
discrete colour steps, so a high-latency link degrades the frame rate and nothing
else.

### Cutting-edge terminals

Terminals such as Warp, Ghostty, kitty and WezTerm offer capabilities Jazz can
detect and use, but never depends on: synchronized output so a frame composites
atomically instead of tearing; procedural block rendering, where the mark, meters
and rails are drawn as exact rectangles that tile seamlessly; OSC 8 hyperlinks so
paths and sources are clickable; the kitty keyboard protocol for real modifier
chords; and desktop notifications when a long run finishes while you are in
another window.

Turn all of them off and the design is unchanged in structure.

### Mouse and scroll

Wheel scrolling is on in the fullscreen interface so a long transcript can move
without arrow keys. OpenTUI does not expose wheel-only mouse reporting — scroll
also replaces the terminal's native click-drag selection with the renderer's own
selection layer. Shift+drag still reaches native selection on many hosts. Copy
also works through footer bindings and OSC 52 where the terminal supports it.

### Headless

Every state carries a word — `ok`, `failed`, `running`, `asking`, `renew`,
`stopped` — so nothing is encoded in colour alone. The interface collapses to a
clean append-only log with one line per state transition, which is more useful in
a CI log than a spinner and is diffable.

The best consequence of designing for headless: **the approval card does not
disappear when nobody is watching — it travels.** The same object, carrying the
same fields and the same named account, reaches you as a band in the terminal, a
message from a bot, or a scoped decision a scheduled run is allowed to make on
its own. It is the one component that has to render in three places, which is why
its content is specified as facts about what will happen rather than as a layout.

See [Surfaces](../surfaces/index.md) for where Jazz runs, and
[Headless](../surfaces/headless.md) for the `jazz run` contract.

---

## Related

- [Tools and approval](../internals/tools-and-approval.md) — how approval decisions are made
- [Context management](../internals/context-management.md) — what the context meter measures
- [Subagents](../internals/subagents.md) — what the lanes represent
- [Personas](../concepts/personas.md) — where the house voice is defined
