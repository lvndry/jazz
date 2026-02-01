import { Context, Effect, Layer } from "effect";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported terminal types for detection and capability profiling.
 */
export type TerminalType =
  | "iterm2"
  | "terminal-app"
  | "warp"
  | "windows-terminal"
  | "xterm"
  | "kitty"
  | "alacritty"
  | "vscode"
  | "unknown";

/**
 * Terminal-specific quirks that affect input/output behavior.
 */
export interface TerminalQuirks {
  /** Warp and some terminals intercept Option shortcuts for their own features */
  readonly interceptsOptionShortcuts: boolean;
  /** Warp has "blocks" mode that changes input behavior */
  readonly hasBlocksMode: boolean;
  /** Some terminals send DEL (0x7f) for backspace instead of BS (0x08) */
  readonly backspaceIsDelete: boolean;
  /** Terminal supports bracketed paste mode */
  readonly supportsBracketedPaste: boolean;
}

/**
 * Escape sequence profile - ordered arrays of sequences to try.
 * First match wins, enabling fallback behavior for unknown terminals.
 */
export interface EscapeSequenceProfile {
  readonly optionLeft: readonly string[];
  readonly optionRight: readonly string[];
  readonly optionDelete: readonly string[];
  readonly optionBackspace: readonly string[];
  readonly ctrlLeft: readonly string[];
  readonly ctrlRight: readonly string[];
  readonly home: readonly string[];
  readonly end: readonly string[];
  readonly deleteKey: readonly string[];
}

/**
 * Complete terminal capabilities including type, features, and escape sequences.
 */
export interface TerminalCapabilities {
  readonly type: TerminalType;
  readonly supportsUnicode: boolean;
  readonly supportsTrueColor: boolean;
  readonly supportsHyperlinks: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly escapeSequences: EscapeSequenceProfile;
  readonly quirks: TerminalQuirks;
}

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Terminal capability detection and profiling service.
 *
 * Provides terminal-aware escape sequence handling using a capability-based
 * approach with fallback chains for unknown terminals.
 */
export interface TerminalCapabilityService {
  /** Get cached terminal capabilities */
  readonly capabilities: Effect.Effect<TerminalCapabilities>;

  /** Force re-detection of terminal capabilities */
  readonly detectTerminal: Effect.Effect<TerminalCapabilities>;

  /** Check if a given escape sequence matches any in the profile for an action */
  readonly matchesSequence: (
    sequence: string,
    action: keyof EscapeSequenceProfile,
  ) => Effect.Effect<boolean>;

  /** Get the terminal width (columns) */
  readonly getColumns: Effect.Effect<number>;

  /** Get the terminal height (rows) */
  readonly getRows: Effect.Effect<number>;
}

export const TerminalCapabilityServiceTag = Context.GenericTag<TerminalCapabilityService>(
  "TerminalCapabilityService",
);

// ============================================================================
// Escape Sequence Profiles (Data-Driven, Not Code Branches)
// ============================================================================

/**
 * Default escape sequences - comprehensive fallback for unknown terminals.
 * Order matters: most common sequences first for faster matching.
 */
const DEFAULT_SEQUENCES: EscapeSequenceProfile = {
  // Option+Left: word backward
  optionLeft: [
    "\x1b[1;3D", // Standard ANSI (iTerm2, xterm)
    "\x1bb", // ESC b (readline/emacs)
    "\x1b[1;9D", // Alternative modifier
    "\x1b[3D", // Simplified
    "\x1b[1;5D", // Ctrl+Left (fallback)
    "\x1b[5D", // Simplified Ctrl
    "\x1b\x1b[D", // Double escape
  ],
  // Option+Right: word forward
  optionRight: [
    "\x1b[1;3C", // Standard ANSI
    "\x1bf", // ESC f (readline/emacs)
    "\x1b[1;9C", // Alternative modifier
    "\x1b[3C", // Simplified
    "\x1b[1;5C", // Ctrl+Right (fallback)
    "\x1b[5C", // Simplified Ctrl
    "\x1b\x1b[C", // Double escape
  ],
  // Option+Delete: delete word forward
  optionDelete: [
    "\x1bd", // ESC d (readline)
    "\x1b[3;3~", // Option+Delete ANSI
  ],
  // Option+Backspace: delete word backward
  optionBackspace: [
    "\x1b\x7f", // ESC + DEL
    "\x1b\x08", // ESC + BS
  ],
  // Ctrl+Left
  ctrlLeft: ["\x1b[1;5D", "\x1b[5D"],
  // Ctrl+Right
  ctrlRight: ["\x1b[1;5C", "\x1b[5C"],
  // Home key
  home: ["\x1b[H", "\x1bOH", "\x1b[1~"],
  // End key
  end: ["\x1b[F", "\x1bOF", "\x1b[4~"],
  // Delete key (forward delete)
  deleteKey: ["\x1b[3~"],
};

/**
 * Terminal-specific sequence profiles.
 * These optimize the ORDER of sequences for known terminals.
 */
const TERMINAL_PROFILES: Record<TerminalType, Partial<EscapeSequenceProfile>> = {
  iterm2: {
    // iTerm2 standard behavior
    optionLeft: ["\x1b[1;3D", "\x1bb", "\x1b[1;9D"],
    optionRight: ["\x1b[1;3C", "\x1bf", "\x1b[1;9C"],
  },
  "terminal-app": {
    // macOS Terminal.app
    optionLeft: ["\x1bb", "\x1b[1;3D"],
    optionRight: ["\x1bf", "\x1b[1;3C"],
  },
  warp: {
    // Warp may intercept Option shortcuts, prioritize Ctrl-based
    optionLeft: ["\x1b[1;5D", "\x1bb", "\x1b[1;3D"],
    optionRight: ["\x1b[1;5C", "\x1bf", "\x1b[1;3C"],
    ctrlLeft: ["\x1b[1;5D"],
    ctrlRight: ["\x1b[1;5C"],
  },
  "windows-terminal": {
    // Windows Terminal uses Ctrl more than Alt/Option
    optionLeft: ["\x1b[1;5D", "\x1b[1;3D"],
    optionRight: ["\x1b[1;5C", "\x1b[1;3C"],
  },
  kitty: {
    // Kitty has good standard support
    optionLeft: ["\x1b[1;3D", "\x1bb"],
    optionRight: ["\x1b[1;3C", "\x1bf"],
  },
  alacritty: {
    // Alacritty standard xterm behavior
    optionLeft: ["\x1b[1;3D", "\x1bb"],
    optionRight: ["\x1b[1;3C", "\x1bf"],
  },
  vscode: {
    // VS Code integrated terminal
    optionLeft: ["\x1b[1;3D", "\x1bb", "\x1b[1;5D"],
    optionRight: ["\x1b[1;3C", "\x1bf", "\x1b[1;5C"],
  },
  xterm: {
    // Standard xterm
    optionLeft: ["\x1b[1;3D", "\x1bb"],
    optionRight: ["\x1b[1;3C", "\x1bf"],
  },
  unknown: {},
};

/**
 * Terminal-specific quirks configuration.
 */
const TERMINAL_QUIRKS: Record<TerminalType, TerminalQuirks> = {
  iterm2: {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: true,
    supportsBracketedPaste: true,
  },
  "terminal-app": {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: true,
    supportsBracketedPaste: true,
  },
  warp: {
    interceptsOptionShortcuts: true, // Warp uses Option for its own features
    hasBlocksMode: true,
    backspaceIsDelete: true,
    supportsBracketedPaste: true,
  },
  "windows-terminal": {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: false,
    supportsBracketedPaste: true,
  },
  kitty: {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: true,
    supportsBracketedPaste: true,
  },
  alacritty: {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: true,
    supportsBracketedPaste: true,
  },
  vscode: {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: true,
    supportsBracketedPaste: true,
  },
  xterm: {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: true,
    supportsBracketedPaste: true,
  },
  unknown: {
    interceptsOptionShortcuts: false,
    hasBlocksMode: false,
    backspaceIsDelete: true,
    supportsBracketedPaste: false,
  },
};

// ============================================================================
// Detection Logic
// ============================================================================

/**
 * Detect terminal type from environment variables.
 */
function detectTerminalType(): TerminalType {
  // Allow user override via environment variable
  const override = process.env["JAZZ_TERMINAL"];
  if (override && isValidTerminalType(override)) {
    return override;
  }

  const termProgram = process.env["TERM_PROGRAM"];
  const term = process.env["TERM"];

  // Warp sets TERM_PROGRAM=WarpTerminal
  if (termProgram === "WarpTerminal") return "warp";

  // iTerm2
  if (termProgram === "iTerm.app") return "iterm2";

  // macOS Terminal.app
  if (termProgram === "Apple_Terminal") return "terminal-app";

  // VS Code integrated terminal
  if (termProgram === "vscode") return "vscode";

  // Windows Terminal (sets WT_SESSION)
  if (process.env["WT_SESSION"]) return "windows-terminal";

  // Kitty (sets KITTY_WINDOW_ID)
  if (process.env["KITTY_WINDOW_ID"]) return "kitty";

  // Alacritty (TERM contains alacritty)
  if (term?.includes("alacritty")) return "alacritty";

  // Generic xterm detection
  if (term?.startsWith("xterm")) return "xterm";

  return "unknown";
}

function isValidTerminalType(value: string): value is TerminalType {
  const validTypes: TerminalType[] = [
    "iterm2",
    "terminal-app",
    "warp",
    "windows-terminal",
    "xterm",
    "kitty",
    "alacritty",
    "vscode",
    "unknown",
  ];
  return validTypes.includes(value as TerminalType);
}

/**
 * Detect color support from environment.
 */
function detectColorSupport(): { unicode: boolean; trueColor: boolean } {
  const colorTerm = process.env["COLORTERM"];
  const term = process.env["TERM"];

  const trueColor =
    colorTerm === "truecolor" ||
    colorTerm === "24bit" ||
    (term?.includes("256color") ?? false) ||
    (term?.includes("truecolor") ?? false);

  // Unicode support - check locale
  const lang = process.env["LANG"] || "";
  const unicode = lang.toLowerCase().includes("utf");

  return { unicode, trueColor };
}

/**
 * Build complete escape sequence profile for a terminal type.
 * Merges terminal-specific overrides with defaults.
 */
function buildSequenceProfile(type: TerminalType): EscapeSequenceProfile {
  const overrides = TERMINAL_PROFILES[type];
  return {
    ...DEFAULT_SEQUENCES,
    ...overrides,
  };
}

/**
 * Build complete terminal capabilities.
 */
function buildCapabilities(type: TerminalType): TerminalCapabilities {
  const { unicode, trueColor } = detectColorSupport();

  return {
    type,
    supportsUnicode: unicode,
    supportsTrueColor: trueColor,
    supportsHyperlinks: type === "iterm2" || type === "kitty" || type === "warp",
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    escapeSequences: buildSequenceProfile(type),
    quirks: TERMINAL_QUIRKS[type],
  };
}

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Create the Terminal Capability Service Layer.
 */
export const TerminalCapabilityServiceLive = Layer.sync(TerminalCapabilityServiceTag, () => {
  // Cache capabilities - only detect once unless explicitly re-detected
  let cachedCapabilities: TerminalCapabilities | null = null;

  const detect = (): TerminalCapabilities => {
    const type = detectTerminalType();
    cachedCapabilities = buildCapabilities(type);
    return cachedCapabilities;
  };

  return {
    capabilities: Effect.sync(() => {
      if (!cachedCapabilities) {
        cachedCapabilities = detect();
      }
      return cachedCapabilities;
    }),

    detectTerminal: Effect.sync(() => detect()),

    matchesSequence: (sequence: string, action: keyof EscapeSequenceProfile) =>
      Effect.sync(() => {
        const caps = cachedCapabilities ?? detect();
        const sequences = caps.escapeSequences[action];
        return sequences.includes(sequence);
      }),

    getColumns: Effect.sync(() => {
      return process.stdout.columns || 80;
    }),

    getRows: Effect.sync(() => {
      return process.stdout.rows || 24;
    }),
  };
});

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get all escape sequences for a specific action across all terminals.
 * Useful for building a comprehensive matcher.
 */
export function getAllSequencesForAction(action: keyof EscapeSequenceProfile): readonly string[] {
  const allSequences = new Set<string>();

  // Add default sequences
  for (const seq of DEFAULT_SEQUENCES[action]) {
    allSequences.add(seq);
  }

  // Add terminal-specific sequences
  for (const profile of Object.values(TERMINAL_PROFILES)) {
    const sequences = profile[action];
    if (sequences) {
      for (const seq of sequences) {
        allSequences.add(seq);
      }
    }
  }

  return Array.from(allSequences);
}

/**
 * Check if a sequence matches any known sequence for an action.
 * This is a pure function for use in the escape state machine.
 */
export function sequenceMatchesAction(
  sequence: string,
  action: keyof EscapeSequenceProfile,
  capabilities: TerminalCapabilities,
): boolean {
  return capabilities.escapeSequences[action].includes(sequence);
}
