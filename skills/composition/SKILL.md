---
name: composition
description: Create high-quality visual compositions with Jazz's `create_composition` tool. Use whenever a user asks for a chart, graph, dashboard, visual explanation, interactive calculator, diagram, tracker, planner, simulation, small game, polished HTML page, or an artifact/visualization that would communicate better than prose alone. Also use proactively when a comparison, trend, process, or decision would materially benefit from an interactive or visual form.
---

# Composition

Turn information into a useful, polished visual artifact. A composition is not
decoration for an answer: it earns its place by making a relationship clearer,
faster to inspect, or easier to act on than prose or a table.

Use `create_composition` to produce it. Jazz stores the HTML under
`~/.jazz/compositions/<session-id>/<composition-name>.html`; a local interactive
session opens the finished composition in the default browser. Chat surfaces
deliver a static image or an interactive link when they support it.

## Decide whether a composition earns its cost

Use a composition when it helps someone see one of these things:

- a trend, distribution, ranking, or comparison;
- a process with three or more steps or branches;
- a system, hierarchy, map, or state transition that is awkward in prose;
- a calculation or planner the person should manipulate;
- a compact briefing someone will revisit or share.

Do not create one for a single fact, a short answer, a simple list, or as a
substitute for missing data. If a small table is clearer, use the table.

## Choose the right visual grammar

Start with the question, then choose the smallest form that answers it.

| Question                           | Best default                                               |
| ---------------------------------- | ---------------------------------------------------------- |
| How does a value change over time? | Line chart; use bars only for discrete periods.            |
| Which categories are larger?       | Sorted horizontal bars.                                    |
| How do two quantities relate?      | Scatter plot with labeled axes.                            |
| What makes up a whole?             | Stacked bars; use a pie only for a few unmistakable parts. |
| What happens next?                 | Timeline, flow, or state diagram.                          |
| What can the person change?        | Small form plus immediate, visible result.                 |
| What should someone scan quickly?  | A restrained dashboard with one primary insight.           |

Do not make a dashboard by default. One strong view with a clear takeaway is
usually more valuable than six generic cards.

## Composition workflow

1. State the decision, question, or action the artifact serves.
2. Identify the primary signal, then remove anything that does not support it.
3. Pick `static` for an immediately readable chart, diagram, or briefing. Pick
   `interactive` only when filtering, exploring, calculating, playing, or input
   changes the answer.
4. Write a complete, self-contained HTML document. Keep CSS and JavaScript
   inline. Do not depend on a build step or local files. Use a CDN only where a
   library adds real value.
5. Make the first screen useful before adding interactions or polish.
6. Call `create_composition` with a short, distinctive title that also makes a
   good filename.
7. In the accompanying answer, say what the person can learn or do with it;
   do not merely announce that a file was made.

## HTML and CSS craft

Use semantic HTML: a meaningful `main`, headings in order, real `button`,
`label`, `input`, `table`, and `nav` elements where appropriate. Do not recreate
native controls with anonymous `div`s.

Design mobile-first. A composition should remain usable at 320px wide and have
a comfortable desktop layout. Use flexible widths, sensible maximum content
widths, `clamp()` for type scale when useful, and a narrow-screen layout that
stacks rather than squeezes important information.

Make hierarchy intentional:

- one dominant title or visual, a concise subtitle, and a clear next action;
- a limited palette with one accent for emphasis, not one color per element;
- enough whitespace to separate ideas without creating empty theater;
- readable typography, short labels, and units next to values;
- motion only when it explains a change; honor `prefers-reduced-motion`.

For controls, provide an accessible name, visible keyboard focus, logical tab
order, and feedback that is understandable without color alone. Use sufficient
contrast and do not hide essential meaning in hover states.

## Data integrity

Treat labels, values, units, dates, and provenance as part of the product.

- Never invent data, sources, or precision.
- Name units and time ranges explicitly.
- Start bar-chart axes at zero unless there is a clearly stated reason not to.
- Avoid truncated axes, decorative 3D effects, rainbow palettes, and unlabeled
  charts that distort comparison.
- If data is illustrative, label it as illustrative.
- If input can be absent, loading, invalid, or empty, design that state rather
  than leaving a broken blank space.

## Mode-specific finish line

For `static`, inspect the requested viewport mentally: all important labels,
the key takeaway, and the legend must be visible without scrolling, hovering,
or clicking. Prefer fewer details over illegible detail.

For `interactive`, make a useful default view before adding controls. Inputs
should have sensible initial values, changes should update quickly, and a person
should be able to understand the result without a separate instruction manual.

## Final quality check

Before calling the tool, ask:

- Would a person understand the point in five seconds?
- Is the chosen chart or interaction the simplest honest representation?
- Can someone use it with a keyboard and on a narrow screen?
- Are all numbers, labels, units, and caveats accurate and visible?
- Did I make a composition rather than a generic dashboard template?
