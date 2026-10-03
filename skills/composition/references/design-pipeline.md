# Design Research Pipeline

Optional external research, for when the artifact needs a real product
identity (forms, decks, polished landing-style pages) and "our house tokens"
isn't enough. Run stages as needed; skip what the artifact doesn't need.
Stages 1–3 are for compositions; stage 4 is for video deliverables; stage 5
is the closing pass on any of them.

## Stage 1 — Style: adopt a `DESIGN.md`

Pick a design system that fits the product, not one that's merely pretty.

1. Browse the catalog: **http://styles.refero.design** (2,000+ `DESIGN.md`
   files analyzed from real product sites — Apple, Linear, Figma, …).
2. Alternative index: **VoltAgent/awesome-design-md** on GitHub (MIT; drop a
   `DESIGN.md` into the project and let agents generate matching UI).
3. Save the chosen file as `DESIGN.md` in the **project root**.
4. Make it binding: add to the project's `CLAUDE.md`
   `@import DESIGN.md` (or a "follow DESIGN.md for colors, typography,
   spacing" rule) so every later artifact inherits it.

Inside a composition, the `DESIGN.md` values become the `:root` tokens in the
`design-system` reference: map the system's palette/typography/spacing onto
`--accent-h/s/l`, the neutral blocks, `--radius`, and the spacing scale. Keep
the one-accent rule — if the system has five brand colors, pick the one that
carries data and demote the rest to neutrals.

Note: for jazz itself, prefer the house tokens; `DESIGN.md` adoption is for
the artifact's _own_ product identity (a client's tool, a pitch deck in a
brand's voice).

## Stage 2 — Components: 21st.dev first, component.gallery second

**Check 21st.dev before hand-rolling any non-trivial component** (tables,
data grids, date pickers, editors, complex forms).

1. **Call it only after saying what you're looking for.** 21st has a free
   limit — **2 free installs per day** (search is free, `21st AI generate`
   uses credits). One good query beats two wasted installs.
2. **Is the MCP installed?** If yes, call it directly. If not:

   ```sh
   npm i -g @21st-dev/cli
   21st login            # opens browser, stores token locally
   21st search "pricing table"
   ```

   MCP config for editors (one endpoint, one login; the CLI returns exactly
   what an MCP client sees):

   ```json
   {
     "mcpServers": {
       "@21st-dev/magic": {
         "command": "npx",
         "args": ["-y", "@21st-dev/magic@latest", "API_KEY=\"<key>\""]
       }
     }
   }
   ```

   Key from 21st.dev/mcp. Old `@21st-dev/magic` API keys were reset — use a
   fresh key.

3. **Adapt, don't paste.** 21st components are **React + Tailwind**; a
   composition is single-file vanilla HTML/CSS. Port the _structure and state
   logic_, restyle with the composition's tokens. For a React project, paste
   with dependencies.
4. **Then check component.gallery** — 60 components × 95 design systems
   (2,671 examples). It shows how _mature_ systems (Material, Carbon, Atlassian,
   …) handle the same component: the right states, labels, edge cases. When
   21st's version and a design system's pattern disagree, the design system
   usually has the answer for state coverage; 21st has the answer for modern
   looks. Take both.

## Stage 3 — Motion: kinetics.colorion.co

Ready-made **spring-physics** motion: 153 recipes, each with a CSS snippet
(a single cubic-bezier mimicking the spring) and/or React code. Categories
cover interaction/input, page transitions, feedback, and ambient.

- Pull the exact `cubic-bezier` for the effect you need (accordion springs,
  toast overshoot, number counter bumps, tab-pill glide, magnetic buttons).
- **House-rule reconciliation:** kinetics loves overshoot
  (`cubic-bezier(0.34, 1.56, 0.64, 1)`); the `motion` reference bans bounce
  on _data_ and _numbers_. Rule: springs for **UI chrome** (toasts, panels,
  pills, buttons), never for chart values, counters, or anything where the
  number must read exactly at rest.
- Every recipe still goes behind `prefers-reduced-motion` and obeys the
  static-mode budget from `motion`.

## Stage 4 — Video: whatships.com references → HyperFrames

For a demo/launch video (not a composition):

1. The user picks reference videos on **whatships.com** (curated startup
   launch/demo videos from X) and sends the links.
2. **Tile the frames to read pacing and transitions:**

   ```sh
   ffmpeg -i video.mp4 -vf "fps=4,scale=320:-1,tile=8x5" frames-tile.png
   ```

   (fps 4 gives a readable storyboard; `analyze_media` on the tile reads the
   cut rhythm, hold lengths, and transition style.)

3. Build the video with **HyperFrames** — open-source "HTML is now a video
   format": compositions in HTML/CSS/GSAP, rendered **deterministically
   frame-by-frame** to MP4 (`npx hyperframes render`). Determinism matters:
   re-rendering the same HTML gives the same video, which screen recording
   cannot guarantee. The motion recipes from stage 3 (and GSAP) are what
   drive the frames.

## Stage 5 — Polish: impeccable.style

If it still feels off when done, run it through **Impeccable**
(**http://impeccable.style** — "the missing design vocabulary for agents"):
its _polish_ pass (hunting the tells that make UI look AI-generated: dead
hierarchy, timid contrast, placeholder copy, inconsistent rounding) and its
_distill_ pass (stripping to what carries the idea). Treat the vocabulary as
a review checklist even without the tool: hierarchy, contrast confidence,
typographic intent, spacing rhythm, and one clear focal point per screen.

## Anti-patterns

- Skipping stage 2 and hand-rolling a data grid — that's the exact case
  21st.dev exists for.
- Burning the 2 free 21st installs on exploratory queries before the
  component decision is made.
- Pasting a Tailwind React component into a vanilla composition and
  praying.
- Adopting a `DESIGN.md` for a chart that needs one accent — house tokens
  are the right weight for most compositions.
- Spring physics on a counter that must land on the exact number.
- Re-recording a video when a HyperFrames re-render gives identical output.
