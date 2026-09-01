/**
 * Centralized glyph sets for the Jazz UI.
 *
 * A CLI cannot ship a font and force the terminal to render with it — the
 * terminal application owns rendering. So every Unicode glyph we emit
 * relies on the user's font having that codepoint and rendering it at the
 * expected width.
 *
 * Two independent things can go wrong, and both were measured rather than
 * assumed. Coverage, from the `cmap` tables of the fonts people actually
 * use (glyphs present / glyphs in block):
 *
 *   Block                        Menlo    SF Mono   Courier
 *   Box Drawing    U+2500–257F   128/128  128/128     0/128
 *   Block Elements U+2580–259F    32/32    32/32      0/32
 *   Geometric      U+25A0–25FF    96/96    14/96      1/96
 *   Arrows         U+2190–21FF   112/112   11/112     0/112
 *   Misc Technical U+2300–23FF   117/256    7/256     0/256
 *   Misc Symbols   U+2600–26FF   149/256    0/256     1/256
 *   Dingbats       U+2700–27BF   144/192   15/192     0/192
 *   Braille        U+2800–28FF     0/256    0/256     0/256
 *
 * And width, from Unicode's EastAsianWidth data: an "Ambiguous" glyph
 * occupies two columns in a CJK-width locale and one everywhere else, so it
 * silently doubles its footprint.
 *
 * Three consequences drive every choice below:
 *
 *   1. Box Drawing and Block Elements are the only ranges with full coverage
 *      everywhere. Dingbats (`✓ ✗ ❯`), Geometric Shapes (`◆ ◐ ● ○`), Arrows
 *      and Misc Symbols (`♪`) are not safe — SF Mono, the default macOS
 *      coding font, is missing most of them and substitutes a fallback font
 *      at a mismatched advance width.
 *   2. Braille has ZERO coverage in Menlo, SF Mono, Courier, Consolas and
 *      JetBrains Mono. Only DejaVu ships it. Every braille spinner in the
 *      ecosystem is drawn by font fallback — which is the origin of the
 *      familiar right-hand gap.
 *   3. Within Block Elements the *quadrants* (`▖▗▘▝▚▞▙▛▜▟`) plus `▐ ░` are
 *      East-Asian Neutral: exactly one column in every locale. The eighth-
 *      block ladder (`▁▂▃▄▅▆▇█`) and shading (`▒▓`) are Ambiguous, so they
 *      are used only where nothing aligns beneath them.
 *
 * So: animation and anything inside a column-aligned region uses the Neutral
 * quadrant set. Frames and rules use Box Drawing. Ambiguous glyphs appear
 * only at line starts and line ends.
 *
 * ASCII remains the fallback for terminals where Unicode is uncertain —
 * every monospace font has had `+`, `-`, `|`, `*`, `>` since the 1970s.
 * `JAZZ_UI_GLYPHS=unicode|ascii` overrides detection either way.
 *
 * Scope of this module: visual chrome only. The markdown renderer's inline
 * emphasis and color choices are unaffected — those are ANSI escapes the
 * terminal renders without font-level glyph dependence.
 */

export type GlyphMode = "ascii" | "unicode";

export interface GlyphSet {
  // ─── Box drawing ─────────────────────────────────────────────────────
  /** Top-left corner */ readonly boxTL: string;
  /** Top junction */ readonly boxTJ: string;
  /** Top-right corner */ readonly boxTR: string;
  /** Mid-left junction */ readonly boxML: string;
  /** Mid junction (cross) */ readonly boxMJ: string;
  /** Mid-right junction */ readonly boxMR: string;
  /** Bottom-left corner */ readonly boxBL: string;
  /** Bottom junction */ readonly boxBJ: string;
  /** Bottom-right corner */ readonly boxBR: string;
  /** Vertical bar */ readonly boxV: string;
  /** Horizontal bar */ readonly boxH: string;
  /** Heavy/section divider line — used for full-width separators */ readonly divider: string;
  /** Heavy horizontal, for emphasis and the filled run of a meter */ readonly ruleHeavy: string;

  // ─── Status / output ─────────────────────────────────────────────────
  /** Success indicator */ readonly success: string;
  /** Error indicator */ readonly error: string;
  /** Warning indicator */ readonly warn: string;
  /** Informational indicator */ readonly info: string;
  /** Debug / metric line marker */ readonly debug: string;
  /** Generic bullet */ readonly bullet: string;
  /** Question / unknown */ readonly question: string;

  // ─── Heading hierarchy markers (rendered mode) ───────────────────────
  /** Marker prefix for H1 headings */ readonly heading1: string;
  /** Marker prefix for H2 headings */ readonly heading2: string;
  /** Marker prefix for H3 headings */ readonly heading3: string;
  /** Marker prefix for H4 headings */ readonly heading4: string;

  // ─── Blockquotes ─────────────────────────────────────────────────────
  /** Left bar for blockquote content */ readonly blockquote: string;

  // ─── Prompt / input ──────────────────────────────────────────────────
  /** Prompt marker on the input line */ readonly promptCursor: string;
  /** Inline arrow (e.g. user message header) */ readonly arrow: string;
  /** Citation reference brackets, as [open, close] */ readonly citeOpen: string;
  readonly citeClose: string;

  // ─── Activity / spinner ──────────────────────────────────────────────
  /** Single-cell spinner frames — quadrant rotation */ readonly spinnerFrames: readonly string[];
  /** Pending / not yet started */ readonly pending: string;
  /** Proposed tool call — the agent is asking for authority */ readonly proposed: string;
  /** Active / connected indicator */ readonly active: string;
  /** A delegated lane closing */ readonly laneEnd: string;

  // ─── Markers ─────────────────────────────────────────────────────────
  /** The agent is speaking */ readonly diamond: string;
  /** Jazz's mark — the swing quadrant */ readonly note: string;
  /** Speaker rail drawn down the left of transcript lines */ readonly rail: string;
  /** Subordinate rail, one level deeper (reasoning, delegated lanes) */ readonly railDeep: string;

  // ─── Activity indicator (multi-cell, expresses parallel work) ────────
  /**
   * Per-lane periods for the activity indicator. Each lane rests, then plays
   * a three-step burst, on its own period. These five are pairwise coprime,
   * so the composite pattern runs 4620 frames — about 13 minutes at 170ms —
   * before it repeats. Non-coprime periods (the previous 4,6,3,4,6) looped
   * in 12 frames, roughly two seconds, and locked two pairs of lanes
   * together permanently.
   */
  readonly lanePeriods: readonly number[];
  /** The burst a lane plays: opening, live, closing. */ readonly laneBurst: readonly string[];
  /** A lane at rest. */ readonly laneRest: string;

  // ─── Context-usage grid cells ────────────────────────────────────────
  /** Grid cell: used tokens */ readonly gridFilled: string;
  /** Grid cell: free tokens */ readonly gridEmpty: string;
  /** Grid cell: reserved/buffer tokens */ readonly gridReserved: string;

  // ─── Todo checklist ──────────────────────────────────────────────────
  // A dedicated mark per state, distinct from the box-drawing status stubs
  // used elsewhere: the checklist is read top-to-bottom as a list of marks,
  // not scanned as a single glance, so a font-native pictogram (checkmark,
  // half-fill, circle) earns its place here even though the stubs above
  // avoid that tradeoff for one-off status indicators.
  /** Not yet started */ readonly todoPending: string;
  /** Currently being worked */ readonly todoActive: string;
  /** Done */ readonly todoDone: string;
  /** Cancelled */ readonly todoCancelled: string;
}

const ASCII: GlyphSet = {
  // Box drawing — the safest characters in monospace history.
  boxTL: "+",
  boxTJ: "+",
  boxTR: "+",
  boxML: "+",
  boxMJ: "+",
  boxMR: "+",
  boxBL: "+",
  boxBJ: "+",
  boxBR: "+",
  boxV: "|",
  boxH: "-",
  divider: "-",
  ruleHeavy: "=",

  // Status: pick chars that read at-a-glance even monochrome.
  success: "+",
  error: "x",
  warn: "!",
  info: "i",
  debug: "*",
  bullet: "*",
  question: "?",

  // Headings render with literal markdown markers — same as hybrid mode,
  // gives clear hierarchy purely from char count without depending on
  // glyph rendering.
  heading1: "#",
  heading2: "##",
  heading3: "###",
  heading4: "####",

  blockquote: ">",

  promptCursor: ">",
  arrow: ">",
  citeOpen: "[",
  citeClose: "]",

  spinnerFrames: ["|", "/", "-", "\\"],
  pending: "o",
  proposed: "|",
  active: "*",
  laneEnd: "+",

  diamond: "-",
  note: "*",
  rail: "|",
  railDeep: ":",

  lanePeriods: [3, 4, 5, 7, 11],
  laneBurst: [".", "o", "O"],
  laneRest: " ",

  gridFilled: "#",
  gridEmpty: ".",
  gridReserved: "~",

  todoPending: "o",
  todoActive: "~",
  todoDone: "x",
  todoCancelled: "-",
};

const UNICODE: GlyphSet = {
  // Box Drawing — 128/128 in Menlo and SF Mono. Light and heavy weights
  // only: rounded (`╭╮╰╯`), double (`╔═╗`) and dashed (`╌╍`) corners are
  // excluded from what terminals draw procedurally and are the most
  // fallback-prone glyphs in the range.
  boxTL: "┌",
  boxTJ: "┬",
  boxTR: "┐",
  boxML: "├",
  boxMJ: "┼",
  boxMR: "┤",
  boxBL: "└",
  boxBJ: "┴",
  boxBR: "┘",
  boxV: "│",
  boxH: "─",
  divider: "─",
  ruleHeavy: "━",

  // Status marks are Box Drawing stubs, all East-Asian Neutral. They read as
  // weight rather than as pictograms, which is the point: `╺` is heavier
  // than `╴`, so success reads as more present than inert without relying
  // on a checkmark glyph that SF Mono does not have.
  // Heavy stubs are settled outcomes, light stubs are transient states. `warn`
  // and `pending` must differ: "needs your attention" and "has not started" are
  // not the same thing, and amber alone cannot carry the distinction in a
  // monochrome terminal.
  success: "╺",
  error: "╻",
  warn: "╵",
  info: "╶",
  debug: "∙",
  bullet: "∙",
  question: "?",

  // Hierarchy by rule weight rather than by decorative markers.
  heading1: "▎",
  heading2: "▏",
  heading3: "∙",
  heading4: "·",

  blockquote: "▏",

  promptCursor: "»",
  arrow: "›",
  citeOpen: "‹",
  citeClose: "›",

  // Quadrant rotation. Replaces the braille `⠋⠙⠹` family, which has zero
  // coverage in every target font.
  spinnerFrames: ["▘", "▝", "▗", "▖"],
  pending: "╴",
  // The agent is asking for authority. `▐` is the only place this glyph
  // appears in the product, so it is unambiguous wherever it shows up.
  proposed: "▐",
  active: "╺",
  laneEnd: "╹",

  // The agent is speaking. Paired with `▐` (asking) at an 8:1 stroke-weight
  // ratio: same geometry, hugging the text on the same side, so the
  // distinction reads as weight rather than as a different shape.
  diamond: "╶",
  // The mark: two filled squares offset off the grid. Syncopation, and the
  // stroke of a `z`. Replaces `♪`, which does not exist in SF Mono at all.
  note: "▞",
  rail: "▎",
  railDeep: "▏",

  lanePeriods: [3, 4, 5, 7, 11],
  laneBurst: ["▖", "▚", "▘"],
  laneRest: "░",

  // Distinguished by shape rather than shade: adjacent density steps like
  // ░/▒ read as near-identical gray at a glance. A solid fill, a sparse
  // dot, and a diagonal checker stay distinct even without color.
  gridFilled: "█",
  gridEmpty: "·",
  gridReserved: "▚",

  todoPending: "○",
  todoActive: "◐",
  todoDone: "✓",
  todoCancelled: "✗",
};

/**
 * Resolve the active glyph mode.
 *
 * `JAZZ_UI_GLYPHS=unicode|ascii` is an explicit override; otherwise the mode
 * is detected from the environment: a UTF-8 locale or a known-capable
 * terminal emulator gets the Unicode set, and anything uncertain (TERM=dumb,
 * TERM=linux console, legacy Windows console, no UTF-8 hint) falls back to
 * ASCII.
 *
 * Read each call rather than memoizing so tests / runtime overrides take
 * effect immediately. Glyph selection is on the cold path of UI rendering
 * (one lookup per logical chrome event), so the cost of re-reading env is
 * negligible.
 */
export function resolveGlyphMode(): GlyphMode {
  const raw = (process.env["JAZZ_UI_GLYPHS"] ?? "").toLowerCase();
  if (raw === "unicode") return "unicode";
  if (raw === "ascii") return "ascii";
  return detectGlyphMode();
}

/** Terminal emulators known to render the Unicode set at correct widths. */
const UNICODE_CAPABLE_TERM_PROGRAMS = new Set([
  "apple_terminal",
  "ghostty",
  "hyper",
  "iterm.app",
  "kitty",
  "tabby",
  "vscode",
  "warpterminal",
  "wezterm",
]);

function detectGlyphMode(): GlyphMode {
  const term = (process.env["TERM"] ?? "").toLowerCase();
  if (term === "dumb" || term === "linux") return "ascii";

  const locale = process.env["LC_ALL"] ?? process.env["LC_CTYPE"] ?? process.env["LANG"] ?? "";
  if (/utf-?8/i.test(locale)) return "unicode";

  const termProgram = (process.env["TERM_PROGRAM"] ?? "").toLowerCase();
  if (UNICODE_CAPABLE_TERM_PROGRAMS.has(termProgram)) return "unicode";

  // Windows Terminal exposes no locale vars but handles Unicode fine.
  if (process.env["WT_SESSION"] !== undefined) return "unicode";

  return "ascii";
}

/** Return the active glyph set. */
export function getGlyphs(): GlyphSet {
  return resolveGlyphMode() === "unicode" ? UNICODE : ASCII;
}

/**
 * One frame of the activity indicator.
 *
 * Each lane rests until the tail of its own period, then plays the burst, so
 * a longer period means a longer rest and the number of moving lanes tracks
 * how much work is actually in flight. Two properties hold for every frame,
 * and both matter: no frame is ever entirely at rest, and no frame has all
 * lanes in the same state. An activity indicator that can look frozen is
 * broken.
 */
export function laneFrame(tick: number, glyphs: GlyphSet = getGlyphs()): string {
  const { lanePeriods, laneBurst, laneRest } = glyphs;
  let frame = "";
  for (let lane = 0; lane < lanePeriods.length; lane++) {
    const period = lanePeriods[lane] as number;
    // Offset each lane by its index so they do not all start together.
    const position = (((tick + lane) % period) + period) % period;
    const restCells = period - laneBurst.length;
    frame += position < restCells ? laneRest : (laneBurst[position - restCells] as string);
  }
  return frame;
}

/** Direct access to either set, e.g. for tests asserting both branches. */
export const GLYPHS = { ascii: ASCII, unicode: UNICODE } as const;
