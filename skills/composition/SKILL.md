---
name: composition
description: Create high-quality visual compositions with Jazz's `create_composition` tool. Use whenever a user asks for a chart, graph, dashboard, visual explanation, interactive calculator, diagram, tracker, planner, simulation, small game, polished HTML page, or an artifact/visualization that would communicate better than prose alone. Also use proactively when a comparison, trend, process, or decision would materially benefit from an interactive or visual form.
---

# Composition

Turn information into a useful, polished visual artifact. A composition is not
decoration for an answer: it earns its place by making a relationship clearer,
faster to inspect, or easier to act on than prose or a table.

Use `create_composition` to produce it. (It is also exposed as the `create_web_app`
alias — same tool, same rules.) Jazz stores the HTML under
`~/.jazz/compositions/<session-id>/<composition-name>.html`; a local interactive
session opens the finished composition in the default browser. Chat surfaces
deliver a static image or an interactive link when they support them.

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

| Question                           | Best default                                                |
| ---------------------------------- | ----------------------------------------------------------- |
| How does a value change over time? | Line chart; use bars only for discrete periods.             |
| Which categories are larger?       | Sorted horizontal bars.                                     |
| How do two quantities relate?      | Scatter plot with labeled axes.                             |
| What makes up a whole?             | Stacked bars; use a pie only for a few unmistakable parts.  |
| What happens next?                 | Timeline, flow, or state diagram.                           |
| What can the person change?        | Small form plus immediate, visible result.                  |
| What should someone scan quickly?  | A restrained dashboard with one primary insight.            |
| What do I walk someone through?    | A deck: one idea per slide (`slides` reference).            |
| What do I fill in to get a result? | A form: the live output is the product (`forms` reference). |
| What do I show as a video?         | whatships references + HyperFrames (`design-pipeline`).     |

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
   library adds real value; hand-rolled SVG beats a chart library for diagrams
   and most concept explainers.
5. Apply the house style: load the `design-system` reference and start the
   document with its token boilerplate. Load `motion` before writing any
   animation, `diagrams` for SVG, `interactive` for controls and state changes.
   Design the motion as part of the layout, not after it (see "Motion design").
6. Make the first screen useful before adding interactions or polish.
7. Call `create_composition` with a short, distinctive title that also makes a
   good filename.
8. In the accompanying answer, say what the person can learn or do with it;
   do not merely announce that a file was made.

## References

- `design-system` — the house style, paste-in design-token boilerplate,
  typography, layout, and color rules. Load it for every composition.
- `motion` — the named animation recipes (staggered reveal, line-draw,
  count-up, view transitions, …) with copy-paste CSS and the static-mode
  screenshot trap. Load it before writing any animation.
- `diagrams` — hand-rolled SVG patterns for flow diagrams, nodes, and state
  transitions. Load it when the artifact is a diagram or explainer.
- `interactive` — popover, dialog, View Transitions, `:has()`, focus and
  accessibility patterns. Load it when the artifact has controls.
- `slides` — deck/presentation mode: 16:9 canvas, keyboard navigation,
  slide transitions, speaker notes, print export. Load it when the person
  wants a Canva-style presentation, pitch, or walkthrough — one idea per
  slide, not a long page.
- `forms` — input→output artifacts where the live result is the product:
  document builders, generators, wizards, checklists, URL/localStorage
  persistence, export. Load it when the person wants a form, builder,
  generator, or anything they fill in to get a result.
- `design-pipeline` — external research stages for real product identity:
  DESIGN.md adoption (refero), 21st.dev + component.gallery components,
  kinetics.colorion.co spring motion, whatships→HyperFrames video,
  impeccable.style polish. Load it when the artifact needs a brand-grade
  look or a video, or when the user names any of these sources.
- `cloudflare-setup` — private publishing: the Cloudflare token/config, the
  one-time Enable Access step, and why the project must be git-integrated
  (direct-upload deploys 500 at the edge). Load it when a private publish
  fails or the person asks how it is hosted. Cloudflare operations use the
  `cf` CLI (wrangler is superseded; it survives only as a build-time dev
  dependency for `cf deploy`).
- `backend-worker-d1` — when a composition needs shared or ticking state
  (multiple browsers, hourly updates, a real database): static Pages
  frontend + one Worker + D1 (managed SQLite) + scheduled cron, all via the
  cf CLI, Access-gated. Load it before designing or building any backend
  for a composition; a working reference implementation lives in the
  `<owner>/compositions-private` repo (`networth/`).
  implementation.

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

## Motion design

Motion is part of the design, not a garnish. A polished composition without
considered motion feels dead; one with confident, directed motion feels alive.
Treat choreography with the same care you give layout and type.

- Load the `motion` reference before writing any animation, and design the
  load as a sequence, not a wall: title → primary visual → supporting detail,
  each timed so the eye knows what to look at. The primary signal lands early
  and is never the last thing to appear.
- Choreograph state changes too, not just the entrance: tab and step switches
  morph instead of blink, updated values pulse, panels open and close. An
  interactive piece that never responds to input with motion feels broken.
- One easing token, one duration family, transform/opacity/filter only, and
  `prefers-reduced-motion` always honored — so every animation reads as one
  directed piece. Content never depends on motion.
- `interactive` mode gets the full choreography (the person actually watches
  it); `static` mode obeys the screenshot budget — entrance animation ≤ 800ms
  or none at all (see the `motion` reference).

## Mode-specific finish line

For `static`, inspect the requested viewport mentally: all important labels,
the key takeaway, and the legend must be visible without scrolling, hovering,
or clicking. Prefer fewer details over illegible detail. Remember the page is
screenshot at `networkidle0` — any entrance animation must have fully
completed by then (see the `motion` reference).

For `interactive`, make a useful default view before adding controls. Inputs
should have sensible initial values, changes should update quickly, and a
person should be able to understand the result without a separate instruction
manual.

## Final quality check

Before calling the tool, ask:

- Would a person understand the point in five seconds?
- Is the chosen chart or interaction the simplest honest representation?
- Does it follow the house style: one accent, token-driven palette, motion
  that explains rather than decorates?
- Is the load choreographed as a sequence with the primary signal landing
  early — and do state changes animate, not blink?
- Is the JavaScript actually alive? A single syntax error kills the whole
  script, and if reveal-on-scroll lives in it, the page renders as a wall of
  empty space. Extract the `<script>` and run it through `node --check` (or a
  quick headless render) before calling the tool.
- Did I make a composition rather than a generic dashboard template?

## Publishing

When the person wants a link they can open from anywhere — share it with
someone, keep it as a permanent artifact, or view it on another device — offer
`publish_composition`. It is the only path that turns a local composition into
something a second person can open without your machine.

Ask **public or private** first; the answer decides the deploy path. If
private, no further questions. If public, ask the host: **GitHub Pages**
(default) or **Cloudflare Pages**.

- `public` + `github` (default): a public repo, a URL anyone with the link can
  open (`<owner>.github.io/compositions/compositions/<slug>/`). Use it for things that
  are fine for strangers to see.
- `public` + `cloudflare`: same, on Cloudflare Pages (the project’s assigned `pages.dev` hostname).
- `private`: a **private repo** (`<owner>/compositions-private`), served by
  Cloudflare Pages and locked behind **Cloudflare Access** on canonical and deployment URLs. Anyone opening the
  URL gets a sign-in screen that sends a one-time PIN to the configured email —
  a real gate, not a login-only link. Both the source file and the page are
  invisible to everyone else.

Offer it, do not assume it: publishing writes to the account `gh` is logged in
as and, on first use, creates a repo, a Pages project, and (for private) an
Access apps there. Preview the host, repository and visibility to the person;
Cloudflare resolves the assigned hostname during publication. Let the approval
gate carry the consent.

- Stable URLs: re-publishing the same name overwrites the same file at the
  same URL instead of minting a new one. Cloudflare deploys the complete composition snapshot so old pages stay available. Change the name to keep an old
  version and add a new one side by side.
- Private requires Cloudflare setup: `~/.config/jazz/cloudflare.json` with a
  token (Pages: Edit, Access: Apps: Edit), the account id, and `accessEmail`.
  Private publication stops before pushing content if email configuration or Access protection is missing. Enable One-time PIN sign-in once in Cloudflare One. The allow lists are managed in
  the Cloudflare One dashboard (Access → Applications → the app → Policies).
  See [Publishing compositions](../../docs/concepts/compositions.md#publish-a-composition-to-a-url).

It needs `gh` (authenticated) and `git` on the machine; the tool says so
plainly if either is missing.
