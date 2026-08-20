import chalk from "chalk";

/**
 * Unified color theme constants for the Jazz CLI.
 *
 * Single source of truth for all colors used in Ink components and chalk styling.
 *
 * Ink's <Text color="..."> supports hex strings (e.g. "#DE9A2C") via chalk
 * when the terminal has truecolor support (chalk.level >= 3). On lower-level
 * terminals chalk auto-downgrades to the closest 256/16-color match.
 */
/**
 * Colour is semantics.
 *
 * Every hue here answers one question a reader actually asks — who is
 * speaking, is this a tool, did it work, should I worry, is this about to
 * touch my real accounts. Six hues is the budget, because six is a set you
 * can hold in your head: after an hour in the app you read colour without
 * deciding to. Everything else — headings, rules, borders, labels,
 * timestamps, paths — lives on the neutral ramp, and emphasis comes from
 * stroke weight, rule weight and shade rather than from adding a hue.
 *
 * There is deliberately ONE accent. The speaker is distinguished by the
 * marker glyph (`»` for you, `╶` for the agent), not by giving each party
 * its own colour — so the accent means "live" wherever it appears.
 *
 * There is deliberately no green in the syntax colours, so success green
 * keeps a single unambiguous meaning.
 *
 * Every value has an exact xterm-256 index, noted inline. The accent is
 * index 45 exactly, so it is byte-identical over SSH rather than
 * approximated by chalk's downgrade.
 */
export interface ThemeColors {
  /** The window's own ground. Painted only where a surface is needed. */
  canvas: string;
  /** Primary accent — live, and the user's own affordances. */
  primary: string;
  /** Live agent identity. Same accent: the glyph says who, the colour says live. */
  agent: string;
  /** Dimmed accent — subordinate live content, links, citations. */
  accentDim: string;
  /** Links and code-adjacent interactive elements. */
  link: string;
  /** Success feedback. */
  success: string;
  /** Error feedback. */
  error: string;
  /** Warning feedback — a scope worth noticing, never a failure. */
  warning: string;
  /** Informational feedback. Sits on the neutral ramp; info is not a hue. */
  info: string;
  /** Primary text. */
  selected: string;
  /** Input prompt marker and active cursor-adjacent accents. */
  prompt: string;
  /** Secondary text. */
  secondary: string;
  /** Dim text — metadata, settled receipts, timestamps. */
  muted: string;
  /** Reasoning is live but subordinate to an answer. */
  reasoning: string;
  /** Tool execution chrome. */
  toolBorder: string;
  /** Subtle surfaces and separators. */
  surface: string;
  surfaceSoft: string;
  surfaceStrong: string;
  border: string;
  borderSoft: string;
  /** Syntax: keywords and structure. */
  syntaxStructure: string;
  /** Syntax: strings, numbers, and inline code. */
  syntaxValue: string;
  /** Syntax: types and constructors. */
  syntaxType: string;
}

export type ThemeVariant = "dark" | "light";

const DARK_PALETTE: ThemeColors = {
  canvas: "#0B0D10", // 233
  primary: "#00D7FF", // 45  — exact cube vertex, byte-identical over SSH
  agent: "#00D7FF", // 45
  accentDim: "#00AFD7", // 38  — exact
  link: "#00AFD7", // 38
  // Green rather than mint. A mint success sits only 113 perceptual units
  // from the steel blue used for types, so a type in a code fence could read
  // as a success mark — and it drifted toward the cyan accent besides.
  success: "#5FD787", // 78  — exact
  error: "#FF6B6B", // 203
  warning: "#D7AF5F", // 179 — exact
  info: "#A9B2BD", // 249 — the neutral ramp; info is not a hue
  selected: "#E8EBEF", // 255
  prompt: "#00D7FF", // 45
  secondary: "#A9B2BD", // 249
  muted: "#5C6673", // 242
  reasoning: "#00AFD7", // 38  — live, but subordinate to an answer
  toolBorder: "#22272E", // 235
  surface: "#14171B", // 234
  surfaceSoft: "#14171B", // 234
  surfaceStrong: "#22272E", // 235
  border: "#22272E", // 235
  borderSoft: "#22272E", // 235
  syntaxStructure: "#9B8CFF", // 105
  // Rose, not sand. A sand value sits 66 perceptual units from the warning
  // amber — which is the amber-overload bug in a subtler form, since inline
  // code and a warning would have read as the same colour. Rose is clear of
  // the amber, the error red, the success green and the cyan accent, and it
  // matches the hue family the light palette uses for the same role.
  syntaxValue: "#D787AF", // 175 — exact
  syntaxType: "#92B4C8", // 110
};

/**
 * The same semantic roles on a light ground. Not an inversion: the accent has
 * to carry real contrast against paper, so cyan darkens to a teal that still
 * reads as the same role, and the syntax tints are re-chosen rather than
 * merely darkened.
 */
const LIGHT_PALETTE: ThemeColors = {
  canvas: "#FBFCFD",
  primary: "#00718F", // 31
  agent: "#00718F", // 31
  accentDim: "#005F87", // 24  — exact cube vertex
  link: "#005F87", // 24
  success: "#116B3E", // 29
  error: "#B3261E", // 124
  warning: "#8A5F00", // 94
  info: "#4A525E", // 240
  selected: "#12151A", // 233
  prompt: "#00718F", // 31
  secondary: "#4A525E", // 240
  muted: "#767F8C", // 245
  reasoning: "#005F87", // 24
  toolBorder: "#D9DEE5", // 253
  surface: "#F1F3F6", // 255
  surfaceSoft: "#F1F3F6", // 255
  surfaceStrong: "#D9DEE5", // 253
  border: "#D9DEE5", // 253
  borderSoft: "#D9DEE5", // 253
  // On paper the syntax tints have to separate by hue rather than by
  // lightness — a first pass used an ochre for values that sat 49 units from
  // the warning amber, which is to say indistinguishable. Plum is far from
  // both the amber and the green, and far from the violet used for structure.
  syntaxStructure: "#5B3FBF", // 61
  syntaxValue: "#9B2C6F", // 126
  syntaxType: "#2F6690", // 24
};

const PALETTES: Record<ThemeVariant, ThemeColors> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
};

/**
 * Resolve the theme variant: `JAZZ_THEME=light|dark` wins; otherwise the
 * terminal's advertised background via `COLORFGBG` (last field is the
 * background color index — 7/15 mean a light background); dark by default.
 */
export function resolveThemeVariant(): ThemeVariant {
  const raw = (process.env["JAZZ_THEME"] ?? "").toLowerCase();
  if (raw === "light") return "light";
  if (raw === "dark") return "dark";
  const colorFgBg = process.env["COLORFGBG"];
  if (colorFgBg) {
    const background = Number(colorFgBg.split(";").at(-1));
    if (background === 7 || background === 15) return "light";
  }
  return "dark";
}

let activeVariant: ThemeVariant = resolveThemeVariant();

/**
 * Mutable theme object — components read `THEME.x` at render time, so
 * switching variants updates everything rendered after the switch. Module
 * constants that captured a color at import time keep the old value until
 * restart (acceptable: /theme persists the choice for the next run too).
 */
export const THEME: ThemeColors = { ...PALETTES[activeVariant] };

export function getThemeVariant(): ThemeVariant {
  return activeVariant;
}

export function setThemeVariant(variant: ThemeVariant): void {
  activeVariant = variant;
  Object.assign(THEME, PALETTES[variant]);
}

/**
 * Unified spacing constants for the Jazz CLI.
 *
 * Single source of truth for all padding/indentation used in Ink components.
 * Every Box that adds horizontal padding should reference these values so the
 * whole UI has consistent left-alignment.
 *
 * Layout hierarchy (left side):
 *   App paddingX = page (2)       → 2 chars left
 *     content paddingLeft = content (2) → +2 chars (tool calls, activity, stream text)
 *       nested paddingLeft = nested (4) → +2 more (multi-line tool results, todo lists)
 *
 * Total horizontal padding budget:
 *   page×2 = 4 chars (both sides from App)
 *   + content = 2 chars (left, inner content)
 *   = 6 chars on the left for most content
 */
export const PADDING = {
  /** Outer page padding (paddingX on the main App container) */
  page: 2,
  /** Content-level left indent (tool calls, stream text, activity phases) */
  content: 2,
  /** Deeply nested content (todo snapshots, multi-line tool results) */
  nested: 4,
} as const;

/**
 * Standardized vertical spacing between UI sections.
 * Use these instead of ad-hoc marginTop/marginBottom values.
 */
export const SPACING = {
  /** Gap between major sections (e.g. after header, between prompt and output) */
  section: 1,
  /** Gap between sub-items within a section (e.g. between menu items and tips) */
  item: 1,
  /** Tight gap for live status rows and compact cards. */
  compact: 0,
} as const;

/**
 * Motion timing constants used for subtle UX feedback.
 */
export const MOTION = {
  instant: 0,
  quick: 90,
  standard: 140,
  gentle: 180,
  /**
   * Frame interval for the activity indicator. Deliberately slow: terminals
   * that buffer a synchronized frame allocate per frame, and the fastest
   * host TUIs are invalidation-driven on a ~250ms heartbeat rather than
   * running an animation loop at all. Nothing here needs to beat 12fps, and
   * a calmer indicator is easier to sit beside for three minutes.
   */
  indicator: 170,
} as const;

/**
 * Total horizontal chars consumed by padding, for pre-wrap width calculations.
 * = page×2 (both sides) + content (left only)
 */
export const PADDING_BUDGET = PADDING.page * 2 + PADDING.content;

/**
 * Chalk function for code/codespan colouring.
 *
 * Resolved per call rather than baked at import, so `/theme` switches it like
 * everything else. It reads `syntaxValue` — the same tint strings and numbers
 * get inside a fenced block — which keeps inline code distinct from both the
 * accent and the warning hue. Previously all three were the same amber, which
 * is why a bulleted list with bold text rendered as a wall of orange.
 */
export const codeColor = (text: string): string => chalk.hex(THEME.syntaxValue)(text);

/**
 * Chalk-based color helpers for non-Ink rendering paths.
 * Use these instead of hardcoded `chalk.blue`, `chalk.cyan`, etc.
 *
 * Getters (not baked instances) so each access reads the CURRENT palette —
 * this is what lets /theme switch light/dark without rebuilding consumers.
 * Each returned value is a real chalk instance, so chaining
 * (`CHALK_THEME.reasoning.italic`) and passing as a function both work.
 */
export const CHALK_THEME = {
  get primary() {
    return chalk.hex(THEME.primary);
  },
  get primaryBold() {
    return chalk.hex(THEME.primary).bold;
  },
  get agent() {
    return chalk.hex(THEME.agent);
  },
  get agentBold() {
    return chalk.hex(THEME.agent).bold;
  },
  get reasoning() {
    return chalk.hex(THEME.reasoning);
  },
  get success() {
    return chalk.hex(THEME.success);
  },
  get error() {
    return chalk.hex(THEME.error);
  },
  get warning() {
    return chalk.hex(THEME.warning);
  },
  get heading() {
    return chalk.bold.hex(THEME.agent);
  },
  get headingUnderline() {
    return chalk.bold.hex(THEME.primary).underline;
  },
  get link() {
    return chalk.hex(THEME.link).underline;
  },
  get muted() {
    return chalk.hex(THEME.secondary);
  },
  get secondary() {
    return chalk.dim;
  },
  get bold() {
    return chalk.bold;
  },
  get white() {
    return chalk.hex(THEME.selected);
  },
} as const;
