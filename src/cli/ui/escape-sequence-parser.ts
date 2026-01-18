/**
 * Escape sequence parser for terminal input handling.
 *
 * Handles various terminal escape sequences for:
 * - Option+Left/Right (word navigation)
 * - Standard arrow keys
 * - Readline shortcuts (Ctrl+A, Ctrl+E, etc.)
 */

// ANSI escape character (ESC)
const ESC = String.fromCharCode(0x1b);

const OPTION_LEFT_REGEX = new RegExp(`^${ESC}\\[(\\d+;)?[359]D$`);
const OPTION_RIGHT_REGEX = new RegExp(`^${ESC}\\[(\\d+;)?[359]C$`);
const ESC_BF_REGEX = new RegExp(`^${ESC}(b|f)$`);
const OPTION_LEFT_INPUT_REGEX = new RegExp(`${ESC}\\[(\\d+;)?[359]D`);
const OPTION_LEFT_INPUT_5D_REGEX = new RegExp(`${ESC}\\[(\\d+;)?5D`);
const OPTION_RIGHT_INPUT_REGEX = new RegExp(`${ESC}\\[(\\d+;)?[359]C`);
const OPTION_RIGHT_INPUT_5C_REGEX = new RegExp(`${ESC}\\[(\\d+;)?5C`);

// Double-escape sequences (some terminals send ESC ESC [ X for Option+Arrow)
const DOUBLE_ESC_LEFT = `${ESC}${ESC}[D`;
const DOUBLE_ESC_RIGHT = `${ESC}${ESC}[C`;
const DOUBLE_ESC_SS3_LEFT = `${ESC}${ESC}OD`;
const DOUBLE_ESC_SS3_RIGHT = `${ESC}${ESC}OC`;

// Command+Arrow sequences (move to line start/end)
const CMD_LEFT_SEQUENCES = [`${ESC}[1;2D`, `${ESC}[H`, `${ESC}OH`];
const CMD_RIGHT_SEQUENCES = [`${ESC}[1;2C`, `${ESC}[F`, `${ESC}OF`, `${ESC}[4~`];

// Option+Delete and Command+Delete
const OPTION_DELETE_SEQUENCE = `${ESC}d`; // ESC d for Option+Delete (forward word delete)
const CMD_DELETE_SEQUENCE = `${ESC}[3;2~`; // Command+Delete variant

/**
 * Key information from useInput hook
 */
export interface KeyInfo {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

/**
 * Parsed input type
 */
export type ParsedInput =
  | { type: "word-left" }
  | { type: "word-right" }
  | { type: "delete-word-back" }
  | { type: "delete-word-forward" }
  | { type: "line-start" }
  | { type: "line-end" }
  | { type: "kill-line-back" }
  | { type: "kill-line-forward" }
  | { type: "delete-char-forward" }
  | { type: "left" }
  | { type: "right" }
  | { type: "backspace" }
  | { type: "submit" }
  | { type: "char"; char: string }
  | { type: "ignore" }
  | { type: "buffering" };

/**
 * Result of parsing input
 */
export interface ParseResult {
  parsed: ParsedInput;
  newBuffer: string;
}

/**
 * Check if input is an Option+Left sequence
 */
function isOptionLeft(input: string, buffer: string): boolean {
  // Check for ESC b (Option+Left)
  if (input === "\x1bb") return true;

  // Check for double-escape sequences
  if (input === DOUBLE_ESC_LEFT || input === DOUBLE_ESC_SS3_LEFT) return true;

  // Check against buffer
  const newBuffer = buffer + input;
  if (newBuffer === DOUBLE_ESC_LEFT || newBuffer === DOUBLE_ESC_SS3_LEFT) return true;

  const isLeftSequence =
    newBuffer === "\x1b[1;3D" ||
    newBuffer === "\x1b[1;9D" ||
    newBuffer === "\x1b[3D" ||
    newBuffer === "\x1b[1;5D" ||
    newBuffer === "\x1b[5D" ||
    OPTION_LEFT_REGEX.test(newBuffer);

  if (isLeftSequence) return true;

  // Check if input already contains the sequence
  if (
    input.includes("\x1bb") ||
    OPTION_LEFT_INPUT_REGEX.test(input) ||
    OPTION_LEFT_INPUT_5D_REGEX.test(input)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if input is an Option+Right sequence
 */
function isOptionRight(input: string, buffer: string): boolean {
  // Check for ESC f (Option+Right)
  if (input === "\x1bf") return true;

  // Check for double-escape sequences
  if (input === DOUBLE_ESC_RIGHT || input === DOUBLE_ESC_SS3_RIGHT) return true;

  // Check against buffer
  const newBuffer = buffer + input;
  if (newBuffer === DOUBLE_ESC_RIGHT || newBuffer === DOUBLE_ESC_SS3_RIGHT) return true;

  const isRightSequence =
    newBuffer === "\x1b[1;3C" ||
    newBuffer === "\x1b[1;9C" ||
    newBuffer === "\x1b[3C" ||
    newBuffer === "\x1b[1;5C" ||
    newBuffer === "\x1b[5C" ||
    OPTION_RIGHT_REGEX.test(newBuffer);

  if (isRightSequence) return true;

  // Check if input already contains the sequence
  if (
    input.includes("\x1bf") ||
    OPTION_RIGHT_INPUT_REGEX.test(input) ||
    OPTION_RIGHT_INPUT_5C_REGEX.test(input)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if input is a Command+Left sequence (move to line start)
 */
function isCommandLeft(input: string, buffer: string): boolean {
  const newBuffer = buffer + input;
  return CMD_LEFT_SEQUENCES.includes(input) || CMD_LEFT_SEQUENCES.includes(newBuffer);
}

/**
 * Check if input is a Command+Right sequence (move to line end)
 */
function isCommandRight(input: string, buffer: string): boolean {
  const newBuffer = buffer + input;
  return CMD_RIGHT_SEQUENCES.includes(input) || CMD_RIGHT_SEQUENCES.includes(newBuffer);
}

/**
 * Check if input is an Option+Delete sequence (delete word forward)
 */
function isOptionDelete(input: string, buffer: string): boolean {
  const newBuffer = buffer + input;
  return input === OPTION_DELETE_SEQUENCE || newBuffer === OPTION_DELETE_SEQUENCE;
}

/**
 * Check if input is a Command+Delete sequence (delete to line start)
 */
function isCommandDelete(input: string, buffer: string): boolean {
  const newBuffer = buffer + input;
  return input === CMD_DELETE_SEQUENCE || newBuffer === CMD_DELETE_SEQUENCE;
}

/**
 * Check if we're still building an escape sequence
 */
function isBufferingEscape(buffer: string): boolean {
  if (buffer === "\x1b") return true;
  if (buffer.startsWith("\x1b[") && buffer.length <= 12) return true;
  if (buffer.length <= 2 && ESC_BF_REGEX.test(buffer)) return true;
  return false;
}

/**
 * Parse terminal input and return the corresponding action.
 *
 * @param input - Raw input string from terminal
 * @param key - Key information from useInput hook
 * @param escapeBuffer - Current escape sequence buffer
 * @returns Parsed input action and updated buffer
 */
export function parseInput(input: string, key: KeyInfo, escapeBuffer: string): ParseResult {
  // Handle escape sequences for Option+Arrow keys and Command+Arrow keys
  let isOptLeft = false;
  let isOptRight = false;
  let isCmdLeft = false;
  let isCmdRight = false;
  let isOptDel = false;
  let isCmdDel = false;

  // Check for single-character escape sequences first
  if (input === "\x1bb") {
    isOptLeft = true;
  } else if (input === "\x1bf") {
    isOptRight = true;
  } else if (input === OPTION_DELETE_SEQUENCE) {
    isOptDel = true;
  }
  // Check if we're building an escape sequence character by character
  else if (input === "\x1b" || escapeBuffer.length > 0) {
    const newBuffer = escapeBuffer + input;

    if (isOptionLeft(input, escapeBuffer)) {
      isOptLeft = true;
    } else if (isOptionRight(input, escapeBuffer)) {
      isOptRight = true;
    } else if (isCommandLeft(input, escapeBuffer)) {
      isCmdLeft = true;
    } else if (isCommandRight(input, escapeBuffer)) {
      isCmdRight = true;
    } else if (isOptionDelete(input, escapeBuffer)) {
      isOptDel = true;
    } else if (isCommandDelete(input, escapeBuffer)) {
      isCmdDel = true;
    } else if (isBufferingEscape(newBuffer)) {
      // Still building the sequence, wait for more input
      return { parsed: { type: "buffering" }, newBuffer };
    }
    // Invalid sequence - clear buffer and continue
  }
  // Check if input contains escape sequences (some terminals send all at once)
  else if (input.includes("\x1b")) {
    if (isOptionLeft(input, "")) {
      isOptLeft = true;
    } else if (isOptionRight(input, "")) {
      isOptRight = true;
    } else if (isCommandLeft(input, "")) {
      isCmdLeft = true;
    } else if (isCommandRight(input, "")) {
      isCmdRight = true;
    } else if (isOptionDelete(input, "")) {
      isOptDel = true;
    } else if (isCommandDelete(input, "")) {
      isCmdDel = true;
    }
  }

  // Clear buffer for non-buffering cases
  const clearedBuffer = "";

  // Ignore certain keys
  if (key.upArrow || key.downArrow || (key.ctrl && input === "c") || key.tab) {
    return { parsed: { type: "ignore" }, newBuffer: clearedBuffer };
  }

  // Submit
  if (key.return) {
    return { parsed: { type: "submit" }, newBuffer: clearedBuffer };
  }

  // Command+Left: move to line start
  if (isCmdLeft) {
    return { parsed: { type: "line-start" }, newBuffer: clearedBuffer };
  }

  // Command+Right: move to line end
  if (isCmdRight) {
    return { parsed: { type: "line-end" }, newBuffer: clearedBuffer };
  }

  // Word-level operations (Option/Alt = meta)
  if ((key.meta && key.leftArrow) || (key.meta && input === "b") || isOptLeft) {
    return { parsed: { type: "word-left" }, newBuffer: clearedBuffer };
  }

  if ((key.meta && key.rightArrow) || (key.meta && input === "f") || isOptRight) {
    return { parsed: { type: "word-right" }, newBuffer: clearedBuffer };
  }

  // Option+Backspace or Ctrl+W: delete word backward
  if ((key.meta && key.backspace) || (key.ctrl && input === "w")) {
    return { parsed: { type: "delete-word-back" }, newBuffer: clearedBuffer };
  }

  // Option+Delete: delete word forward
  if ((key.meta && key.delete) || isOptDel) {
    return { parsed: { type: "delete-word-forward" }, newBuffer: clearedBuffer };
  }

  // Command+Delete: delete to line start
  if (isCmdDel) {
    return { parsed: { type: "kill-line-back" }, newBuffer: clearedBuffer };
  }

  // Readline shortcuts
  if (key.ctrl && input === "a") {
    return { parsed: { type: "line-start" }, newBuffer: clearedBuffer };
  }

  if (key.ctrl && input === "e") {
    return { parsed: { type: "line-end" }, newBuffer: clearedBuffer };
  }

  if (key.ctrl && input === "u") {
    return { parsed: { type: "kill-line-back" }, newBuffer: clearedBuffer };
  }

  if (key.ctrl && input === "k") {
    return { parsed: { type: "kill-line-forward" }, newBuffer: clearedBuffer };
  }

  if (key.ctrl && input === "d") {
    return { parsed: { type: "delete-char-forward" }, newBuffer: clearedBuffer };
  }

  // Basic navigation
  if (key.leftArrow) {
    return { parsed: { type: "left" }, newBuffer: clearedBuffer };
  }

  if (key.rightArrow) {
    return { parsed: { type: "right" }, newBuffer: clearedBuffer };
  }

  // Deletion
  if (key.backspace || key.delete) {
    return { parsed: { type: "backspace" }, newBuffer: clearedBuffer };
  }

  // Regular input (skip if escape sequence detected)
  if (!key.ctrl && !key.meta && !isOptLeft && !isOptRight && !isCmdLeft && !isCmdRight && !isOptDel && !isCmdDel && !input.includes("\x1b")) {
    return { parsed: { type: "char", char: input }, newBuffer: clearedBuffer };
  }

  return { parsed: { type: "ignore" }, newBuffer: clearedBuffer };
}
