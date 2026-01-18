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

// Pre-compiled regex patterns for escape sequence detection
const OPTION_LEFT_REGEX = new RegExp(`^${ESC}\\[(\\d+;)?[359]D$`);
const OPTION_RIGHT_REGEX = new RegExp(`^${ESC}\\[(\\d+;)?[359]C$`);
const ESC_BF_REGEX = new RegExp(`^${ESC}(b|f)$`);
const OPTION_LEFT_INPUT_REGEX = new RegExp(`${ESC}\\[(\\d+;)?[359]D`);
const OPTION_LEFT_INPUT_5D_REGEX = new RegExp(`${ESC}\\[(\\d+;)?5D`);
const OPTION_RIGHT_INPUT_REGEX = new RegExp(`${ESC}\\[(\\d+;)?[359]C`);
const OPTION_RIGHT_INPUT_5C_REGEX = new RegExp(`${ESC}\\[(\\d+;)?5C`);

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

  // Check against buffer
  const newBuffer = buffer + input;
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

  // Check against buffer
  const newBuffer = buffer + input;
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
  // Handle escape sequences for Option+Arrow keys
  let isOptLeft = false;
  let isOptRight = false;

  // Check for single-character escape sequences first
  if (input === "\x1bb") {
    isOptLeft = true;
  } else if (input === "\x1bf") {
    isOptRight = true;
  }
  // Check if we're building an escape sequence character by character
  else if (input === "\x1b" || escapeBuffer.length > 0) {
    const newBuffer = escapeBuffer + input;

    if (isOptionLeft(input, escapeBuffer)) {
      isOptLeft = true;
    } else if (isOptionRight(input, escapeBuffer)) {
      isOptRight = true;
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

  // Word-level operations (Option/Alt = meta)
  if ((key.meta && key.leftArrow) || isOptLeft) {
    return { parsed: { type: "word-left" }, newBuffer: clearedBuffer };
  }

  if ((key.meta && key.rightArrow) || isOptRight) {
    return { parsed: { type: "word-right" }, newBuffer: clearedBuffer };
  }

  // Option+Backspace or Ctrl+W: delete word backward
  if ((key.meta && key.backspace) || (key.ctrl && input === "w")) {
    return { parsed: { type: "delete-word-back" }, newBuffer: clearedBuffer };
  }

  // Option+Delete: delete word forward
  if (key.meta && key.delete) {
    return { parsed: { type: "delete-word-forward" }, newBuffer: clearedBuffer };
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
  if (!key.ctrl && !key.meta && !isOptLeft && !isOptRight && !input.includes("\x1b")) {
    return { parsed: { type: "char", char: input }, newBuffer: clearedBuffer };
  }

  return { parsed: { type: "ignore" }, newBuffer: clearedBuffer };
}
