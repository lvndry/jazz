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
 * Solution: route every UI glyph through this module, detect whether the
 * terminal can render Unicode (UTF-8 locale or a known-capable emulator),
 * and fall back to ASCII (every monospace font has had `+`, `-`, `|`, `*`,
 * `>` since the 1970s) when uncertain. `JAZZ_UI_GLYPHS=unicode|ascii`
 * overrides detection either way.
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
  /** Active / connected indicator (status dot on) */ readonly active: string;

  // ─── Markers ─────────────────────────────────────────────────────────
  /** Agent response header marker */ readonly diamond: string;

  // ─── Context-usage grid cells ────────────────────────────────────────
  /** Grid cell: used tokens */ readonly gridFilled: string;
  /** Grid cell: free tokens */ readonly gridEmpty: string;
  /** Grid cell: reserved/buffer tokens */ readonly gridReserved: string;
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
  active: "*",

  diamond: "*",

  gridFilled: "#",
  gridEmpty: ".",
  gridReserved: "~",
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
  active: "●",

  diamond: "◆",

  gridFilled: "█",
  gridEmpty: "░",
  gridReserved: "▒",
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

/** Direct access to either set, e.g. for tests asserting both branches. */
export const GLYPHS = { ascii: ASCII, unicode: UNICODE } as const;
