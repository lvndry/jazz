/**
 * Centralized glyph sets for the Jazz UI.
 *
 * A CLI cannot ship a font and force the terminal to render with it — the
 * terminal application owns rendering. So every Unicode glyph we emit
 * relies on the user's font having that codepoint and rendering it at the
 * expected width. macOS Menlo (the default in Terminal.app), Consolas,
 * and many CJK fonts fall back to a different font for box-drawing chars
 * (U+2500 range), arrows, and decorative dingbats — and the fallback's
 * advance width often differs by a fraction of a column, which mis-aligns
 * everything that depends on column math (tables, progress bars, anything
 * inside a Box).
 *
 * Solution: route every UI glyph through this module, default to ASCII
 * (every monospace font has had `+`, `-`, `|`, `*`, `>` since the 1970s),
 * and let users opt into the Unicode set via `JAZZ_UI_GLYPHS=unicode`
 * once they've confirmed their font handles it cleanly.
 *
 * Scope of this module: visual chrome only. The markdown renderer's
 * inline emphasis (bold/italic/strikethrough) and color choices are
 * unaffected — those are ANSI escapes the terminal renders without
 * font-level glyph dependence.
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

  // ─── Status / output ─────────────────────────────────────────────────
  /** Success indicator */ readonly success: string;
  /** Error indicator */ readonly error: string;
  /** Warning indicator */ readonly warn: string;
  /** Info indicator */ readonly info: string;
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
  /** Prompt cursor (input line) */ readonly promptCursor: string;
  /** Inline arrow (e.g. user message header) */ readonly arrow: string;

  // ─── Activity / spinner ──────────────────────────────────────────────
  /** Spinner animation frames */ readonly spinnerFrames: readonly string[];
  /** Pending / paused indicator */ readonly pending: string;
  /** Pending tool call (proposed but not yet approved/run) */ readonly proposed: string;
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

  // 8-frame ASCII spinner — universal, smooth enough.
  spinnerFrames: ["|", "/", "-", "\\", "|", "/", "-", "\\"],
  pending: "o",
  proposed: "?",
};

const UNICODE: GlyphSet = {
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

  success: "✓",
  error: "✗",
  warn: "⚠",
  info: "ℹ",
  debug: "✧",
  bullet: "•",
  question: "?",

  heading1: "◆",
  heading2: "▸",
  heading3: "•",
  heading4: "·",

  blockquote: "▏",

  promptCursor: "❯",
  arrow: "›",

  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  pending: "○",
  proposed: "◐",
};

/**
 * Resolve the active glyph mode from env. Default `ascii`.
 *
 * Read each call rather than memoizing so tests / runtime overrides take
 * effect immediately. Glyph selection is on the cold path of UI rendering
 * (one lookup per logical chrome event), so the cost of re-reading env is
 * negligible.
 */
export function resolveGlyphMode(): GlyphMode {
  const raw = (process.env["JAZZ_UI_GLYPHS"] ?? "").toLowerCase();
  if (raw === "unicode") return "unicode";
  return "ascii";
}

/** Return the active glyph set. */
export function getGlyphs(): GlyphSet {
  return resolveGlyphMode() === "unicode" ? UNICODE : ASCII;
}

/** Direct access to either set, e.g. for tests asserting both branches. */
export const GLYPHS = { ascii: ASCII, unicode: UNICODE } as const;
