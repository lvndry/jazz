import { Effect } from "effect";
import type { EscapeSequenceProfile, TerminalCapabilities } from "../services/terminal-service";

// ============================================================================
// Types
// ============================================================================

/**
 * Key information from Ink's useInput hook.
 */
export interface KeyInfo {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly leftArrow: boolean;
  readonly rightArrow: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly tab: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly meta: boolean;
}

/**
 * Parsed input action - the result of processing terminal input.
 */
export type ParsedInput =
  | { readonly type: "word-left" }
  | { readonly type: "word-right" }
  | { readonly type: "delete-word-back" }
  | { readonly type: "delete-word-forward" }
  | { readonly type: "line-start" }
  | { readonly type: "line-end" }
  | { readonly type: "kill-line-back" }
  | { readonly type: "kill-line-forward" }
  | { readonly type: "delete-char-forward" }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "backspace" }
  | { readonly type: "submit" }
  | { readonly type: "escape" }
  | { readonly type: "tab" }
  | { readonly type: "expand-diff" }
  | { readonly type: "char"; readonly char: string }
  | { readonly type: "ignore" };

/**
 * State machine states for escape sequence parsing.
 */
export type EscapeState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "EscapeReceived"; readonly timestamp: number }
  | { readonly _tag: "CSISequence"; readonly buffer: string; readonly timestamp: number }
  | { readonly _tag: "SS3Sequence"; readonly buffer: string; readonly timestamp: number }
  | { readonly _tag: "DoubleEscape"; readonly timestamp: number };

/**
 * Result of a state machine transition.
 */
export type TransitionResult =
  | { readonly _tag: "Continue"; readonly state: EscapeState }
  | { readonly _tag: "Complete"; readonly action: ParsedInput }
  | { readonly _tag: "CompleteWithRemainder"; readonly action: ParsedInput; readonly remainder: string };

/**
 * Escape sequence state machine interface.
 */
export interface EscapeStateMachine {
  /**
   * Process input and return the resulting action.
   * Handles escape sequences, key combinations, and regular characters.
   */
  readonly process: (input: string, key: KeyInfo) => Effect.Effect<ParsedInput>;

  /**
   * Reset the state machine to idle state.
   */
  readonly reset: Effect.Effect<void>;

  /**
   * Get the current state (for debugging/testing).
   */
  readonly getState: Effect.Effect<EscapeState>;

  /**
   * Check if the state machine is currently buffering an escape sequence.
   */
  readonly isBuffering: Effect.Effect<boolean>;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum time to wait for escape sequence completion (ms) */
const ESCAPE_TIMEOUT_MS = 100;

/** Maximum buffer length for escape sequences */
const MAX_BUFFER_LENGTH = 10;

/** ESC character */
const ESC = "\x1b";

/** CSI introducer (ESC [) */
const CSI = "\x1b[";

/** SS3 introducer (ESC O) */
const SS3 = "\x1bO";

// ============================================================================
// State Machine Implementation
// ============================================================================

/**
 * Create an escape sequence state machine.
 *
 * @param capabilities - Terminal capabilities for sequence matching
 * @returns Effect-wrapped state machine instance
 */
export function createEscapeStateMachine(
  capabilities: TerminalCapabilities,
): EscapeStateMachine {
  let state: EscapeState = { _tag: "Idle" };
  let lastInputTime = 0;

  /**
   * Check if a buffer matches any sequence in the profile.
   */
  function matchSequence(
    buffer: string,
    action: keyof EscapeSequenceProfile,
  ): boolean {
    return capabilities.escapeSequences[action].includes(buffer);
  }

  /**
   * Try to match the complete buffer against known sequences.
   */
  function tryMatchCompleteSequence(buffer: string): ParsedInput | null {
    // Word navigation
    if (matchSequence(buffer, "optionLeft") || matchSequence(buffer, "ctrlLeft")) {
      return { type: "word-left" };
    }
    if (matchSequence(buffer, "optionRight") || matchSequence(buffer, "ctrlRight")) {
      return { type: "word-right" };
    }

    // Word deletion
    if (matchSequence(buffer, "optionDelete")) {
      return { type: "delete-word-forward" };
    }
    if (matchSequence(buffer, "optionBackspace")) {
      return { type: "delete-word-back" };
    }

    // Line navigation
    if (matchSequence(buffer, "home")) {
      return { type: "line-start" };
    }
    if (matchSequence(buffer, "end")) {
      return { type: "line-end" };
    }

    // Forward delete
    if (matchSequence(buffer, "deleteKey")) {
      return { type: "delete-char-forward" };
    }

    return null;
  }

  /**
   * Handle CSI sequence (ESC [).
   * CSI sequences are: ESC [ <params> <final>
   * - params: digits and semicolons
   * - final: a letter or ~
   */
  function handleCSISequence(buffer: string, char: string): TransitionResult {
    const newBuffer = buffer + char;
    const fullSequence = CSI + newBuffer;

    // Check if this completes a sequence
    const match = tryMatchCompleteSequence(fullSequence);
    if (match) {
      return { _tag: "Complete", action: match };
    }

    // Check for standard arrow keys (no modifier)
    if (buffer === "" && char === "D") {
      return { _tag: "Complete", action: { type: "left" } };
    }
    if (buffer === "" && char === "C") {
      return { _tag: "Complete", action: { type: "right" } };
    }
    if (buffer === "" && char === "A") {
      return { _tag: "Complete", action: { type: "up" } };
    }
    if (buffer === "" && char === "B") {
      return { _tag: "Complete", action: { type: "down" } };
    }

    // Check for Home/End keys
    if (buffer === "" && char === "H") {
      return { _tag: "Complete", action: { type: "line-start" } };
    }
    if (buffer === "" && char === "F") {
      return { _tag: "Complete", action: { type: "line-end" } };
    }

    // Check for modified arrow keys: ESC [ 1 ; <mod> <dir>
    // mod: 2=Shift, 3=Alt/Option, 5=Ctrl, 9=Alt (some terminals)
    const modifiedArrowMatch = /^1;([2359])([ABCD])$/.exec(newBuffer);
    if (modifiedArrowMatch) {
      const [, modifier, direction] = modifiedArrowMatch;
      const isWordNav = modifier === "3" || modifier === "5" || modifier === "9";

      if (direction === "D") {
        return { _tag: "Complete", action: { type: isWordNav ? "word-left" : "left" } };
      }
      if (direction === "C") {
        return { _tag: "Complete", action: { type: isWordNav ? "word-right" : "right" } };
      }
      if (direction === "A") {
        return { _tag: "Complete", action: { type: "up" } };
      }
      if (direction === "B") {
        return { _tag: "Complete", action: { type: "down" } };
      }
    }

    // Check for delete key: ESC [ 3 ~
    if (newBuffer === "3~") {
      return { _tag: "Complete", action: { type: "delete-char-forward" } };
    }

    // Check for modified delete: ESC [ 3 ; <mod> ~
    const modifiedDeleteMatch = /^3;([235])~$/.exec(newBuffer);
    if (modifiedDeleteMatch) {
      const [, modifier] = modifiedDeleteMatch;
      if (modifier === "3") {
        // Option+Delete
        return { _tag: "Complete", action: { type: "delete-word-forward" } };
      }
      // Ctrl+Delete or Shift+Delete - treat as delete
      return { _tag: "Complete", action: { type: "delete-char-forward" } };
    }

    // Check if buffer is getting too long (invalid sequence)
    if (newBuffer.length > MAX_BUFFER_LENGTH) {
      return { _tag: "Complete", action: { type: "ignore" } };
    }

    // Check if this could still become a valid sequence
    // Valid CSI chars: digits, semicolons, then a letter or ~
    const isValidCSIChar = /^[\d;]*$/.test(newBuffer) || /^[\d;]*[A-Za-z~]$/.test(newBuffer);
    if (!isValidCSIChar) {
      return { _tag: "Complete", action: { type: "ignore" } };
    }

    // Continue buffering
    return {
      _tag: "Continue",
      state: { _tag: "CSISequence", buffer: newBuffer, timestamp: lastInputTime },
    };
  }

  /**
   * Handle SS3 sequence (ESC O).
   * SS3 sequences are typically: ESC O <letter>
   */
  function handleSS3Sequence(buffer: string, char: string): TransitionResult {
    const newBuffer = buffer + char;
    const fullSequence = SS3 + newBuffer;

    // Check if this completes a sequence
    const match = tryMatchCompleteSequence(fullSequence);
    if (match) {
      return { _tag: "Complete", action: match };
    }

    // Application mode arrow keys
    if (char === "D") return { _tag: "Complete", action: { type: "left" } };
    if (char === "C") return { _tag: "Complete", action: { type: "right" } };
    if (char === "A") return { _tag: "Complete", action: { type: "up" } };
    if (char === "B") return { _tag: "Complete", action: { type: "down" } };

    // Application mode Home/End
    if (char === "H") return { _tag: "Complete", action: { type: "line-start" } };
    if (char === "F") return { _tag: "Complete", action: { type: "line-end" } };

    // Buffer too long or invalid
    if (newBuffer.length > 4) {
      return { _tag: "Complete", action: { type: "ignore" } };
    }

    // Continue buffering
    return {
      _tag: "Continue",
      state: { _tag: "SS3Sequence", buffer: newBuffer, timestamp: lastInputTime },
    };
  }

  /**
   * Handle input after receiving ESC.
   */
  function handleAfterEscape(char: string): TransitionResult {
    // ESC [ - CSI sequence
    if (char === "[") {
      return {
        _tag: "Continue",
        state: { _tag: "CSISequence", buffer: "", timestamp: lastInputTime },
      };
    }

    // ESC O - SS3 sequence
    if (char === "O") {
      return {
        _tag: "Continue",
        state: { _tag: "SS3Sequence", buffer: "", timestamp: lastInputTime },
      };
    }

    // ESC ESC - Double escape (some terminals)
    if (char === ESC) {
      return {
        _tag: "Continue",
        state: { _tag: "DoubleEscape", timestamp: lastInputTime },
      };
    }

    // ESC b - word left (readline)
    if (char === "b") {
      return { _tag: "Complete", action: { type: "word-left" } };
    }

    // ESC f - word right (readline)
    if (char === "f") {
      return { _tag: "Complete", action: { type: "word-right" } };
    }

    // ESC d - delete word forward (readline)
    if (char === "d") {
      return { _tag: "Complete", action: { type: "delete-word-forward" } };
    }

    // ESC DEL (0x7f) - delete word backward
    if (char === "\x7f") {
      return { _tag: "Complete", action: { type: "delete-word-back" } };
    }

    // ESC BS (0x08) - delete word backward
    if (char === "\x08") {
      return { _tag: "Complete", action: { type: "delete-word-back" } };
    }

    // Unknown ESC sequence - treat as escape key press followed by character
    // Return the escape action and let the caller handle the remaining char
    return { _tag: "CompleteWithRemainder", action: { type: "escape" }, remainder: char };
  }

  /**
   * Handle double escape sequence (ESC ESC).
   */
  function handleDoubleEscape(char: string): TransitionResult {
    // ESC ESC [ D/C - Alternative word navigation in some terminals
    if (char === "[") {
      return {
        _tag: "Continue",
        state: { _tag: "CSISequence", buffer: "", timestamp: lastInputTime },
      };
    }

    // Unknown double escape - ignore
    return { _tag: "Complete", action: { type: "ignore" } };
  }

  /**
   * Process Ctrl key combinations.
   */
  function handleCtrlKey(input: string, key: KeyInfo): ParsedInput | null {
    if (!key.ctrl) return null;

    // Ctrl+A - line start
    if (input === "a" || input === "\x01") {
      return { type: "line-start" };
    }

    // Ctrl+E - line end
    if (input === "e" || input === "\x05") {
      return { type: "line-end" };
    }

    // Ctrl+U - kill line backward
    if (input === "u" || input === "\x15") {
      return { type: "kill-line-back" };
    }

    // Ctrl+K - kill line forward
    if (input === "k" || input === "\x0b") {
      return { type: "kill-line-forward" };
    }

    // Ctrl+W - delete word backward
    if (input === "w" || input === "\x17") {
      return { type: "delete-word-back" };
    }

    // Ctrl+D - delete char forward (or EOF, but we handle as delete)
    if (input === "d" || input === "\x04") {
      return { type: "delete-char-forward" };
    }

    // Ctrl+H - backspace
    if (input === "h" || input === "\x08") {
      return { type: "backspace" };
    }

    // Ctrl+C - ignore (let it propagate for interrupt handling)
    if (input === "c" || input === "\x03") {
      return { type: "ignore" };
    }

    // Ctrl+O - expand diff output
    if (input === "o" || input === "\x0f") {
      return { type: "expand-diff" };
    }

    return null;
  }

  /**
   * Process Meta (Option/Alt) key combinations with Ink's meta flag.
   */
  function handleMetaKey(input: string, key: KeyInfo): ParsedInput | null {
    if (!key.meta) return null;

    // Meta+Left - word left
    if (key.leftArrow) {
      return { type: "word-left" };
    }

    // Meta+Right - word right
    if (key.rightArrow) {
      return { type: "word-right" };
    }

    // Meta+Backspace - delete word backward
    if (key.backspace) {
      return { type: "delete-word-back" };
    }

    // Meta+Delete - delete word backward (common on Mac where Backspace is reported as Delete)
    if (key.delete && !input.startsWith(ESC)) {
      return { type: "delete-word-back" };
    }

    // Meta+b - word left
    if (input === "b") {
      return { type: "word-left" };
    }

    // Meta+f - word right
    if (input === "f") {
      return { type: "word-right" };
    }

    return null;
  }

  /**
   * Main transition function.
   */
  function transition(input: string, key: KeyInfo): ParsedInput {
    const now = Date.now();

    // Check for timeout on incomplete sequences
    if (state._tag !== "Idle" && "timestamp" in state) {
      if (now - state.timestamp > ESCAPE_TIMEOUT_MS) {
        // Sequence timed out - reset and process as new input
        state = { _tag: "Idle" };
      }
    }

    lastInputTime = now;

    // Handle based on current state
    switch (state._tag) {
      case "Idle": {
        // Check for special keys first (from Ink's key parsing)
        if (key.return) {
          return { type: "submit" };
        }

        if (key.tab) {
          return { type: "tab" };
        }

        if (key.upArrow) {
          return { type: "up" };
        }

        if (key.downArrow) {
          return { type: "down" };
        }

        if (key.leftArrow && !key.meta && !key.ctrl) {
          return { type: "left" };
        }

        if (key.rightArrow && !key.meta && !key.ctrl) {
          return { type: "right" };
        }

        // Backspace
        if (key.backspace || input === "\x7f" || input === "\x08") {
          if (key.meta) {
            return { type: "delete-word-back" };
          }
          return { type: "backspace" };
        }

        // Delete key (when Ink detects it without escape sequence)
        // Note: Map to backspace to handle Mac/terminals where Backspace is reported as Delete
        if (key.delete && !input.startsWith(ESC)) {
          if (key.meta) {
            return { type: "delete-word-back" };
          }
          return { type: "backspace" };
        }

        // Escape key alone
        if (key.escape && input === ESC) {
          // Start buffering - might be start of escape sequence
          state = { _tag: "EscapeReceived", timestamp: now };
          return { type: "ignore" }; // Will be resolved on next input or timeout
        }

        // Ctrl key combinations
        const ctrlResult = handleCtrlKey(input, key);
        if (ctrlResult) {
          return ctrlResult;
        }

        // Meta (Option/Alt) key combinations
        const metaResult = handleMetaKey(input, key);
        if (metaResult) {
          return metaResult;
        }

        // Raw escape sequence in input (terminal sent full sequence at once)
        if (input.startsWith(ESC) && input.length > 1) {
          // Check if it's a complete known sequence
          const match = tryMatchCompleteSequence(input);
          if (match) {
            return match;
          }

          // Parse character by character
          for (let i = 0; i < input.length; i++) {
            const char = input[i];
            if (char === undefined) continue;

            if (i === 0 && char === ESC) {
              state = { _tag: "EscapeReceived", timestamp: now };
              continue;
            }

            const result = processCharInState(char);
            if (result._tag === "Complete") {
              state = { _tag: "Idle" };
              return result.action;
            }
            if (result._tag === "CompleteWithRemainder") {
              state = { _tag: "Idle" };
              // For simplicity, we return the action and ignore remainder
              // In practice, the input is usually a complete sequence
              return result.action;
            }
            if (result._tag === "Continue") {
              state = result.state;
            }
          }

          // If we're still buffering after processing all chars, return ignore
          // The sequence will complete on next input
          return { type: "ignore" };
        }

        // Regular character input
        if (input.length === 1 && !key.ctrl && !key.meta && input >= " ") {
          return { type: "char", char: input };
        }

        // Multi-byte UTF-8 character
        if (input.length > 0 && !key.ctrl && !key.meta && !input.startsWith(ESC)) {
          return { type: "char", char: input };
        }

        return { type: "ignore" };
      }

      case "EscapeReceived": {
        const result = handleAfterEscape(input);
        if (result._tag === "Complete") {
          state = { _tag: "Idle" };
          return result.action;
        }
        if (result._tag === "CompleteWithRemainder") {
          state = { _tag: "Idle" };
          return result.action;
        }
        state = result.state;
        return { type: "ignore" };
      }

      case "CSISequence": {
        const result = handleCSISequence(state.buffer, input);
        if (result._tag === "Complete") {
          state = { _tag: "Idle" };
          return result.action;
        }
        if (result._tag === "CompleteWithRemainder") {
          state = { _tag: "Idle" };
          return result.action;
        }
        state = result.state;
        return { type: "ignore" };
      }

      case "SS3Sequence": {
        const result = handleSS3Sequence(state.buffer, input);
        if (result._tag === "Complete") {
          state = { _tag: "Idle" };
          return result.action;
        }
        if (result._tag === "CompleteWithRemainder") {
          state = { _tag: "Idle" };
          return result.action;
        }
        state = result.state;
        return { type: "ignore" };
      }

      case "DoubleEscape": {
        const result = handleDoubleEscape(input);
        if (result._tag === "Complete") {
          state = { _tag: "Idle" };
          return result.action;
        }
        if (result._tag === "Continue") {
          state = result.state;
        }
        return { type: "ignore" };
      }
    }
  }

  /**
   * Helper to process a single character in current state.
   */
  function processCharInState(char: string): TransitionResult {
    switch (state._tag) {
      case "EscapeReceived":
        return handleAfterEscape(char);
      case "CSISequence":
        return handleCSISequence(state.buffer, char);
      case "SS3Sequence":
        return handleSS3Sequence(state.buffer, char);
      case "DoubleEscape":
        return handleDoubleEscape(char);
      default:
        return { _tag: "Complete", action: { type: "ignore" } };
    }
  }

  return {
    process: (input: string, key: KeyInfo) =>
      Effect.sync(() => transition(input, key)),

    reset: Effect.sync(() => {
      state = { _tag: "Idle" };
    }),

    getState: Effect.sync(() => state),

    isBuffering: Effect.sync(() => state._tag !== "Idle"),
  };
}

// ============================================================================
// Default Key Info
// ============================================================================

/**
 * Create a default KeyInfo object with all flags false.
 */
export function createDefaultKeyInfo(): KeyInfo {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
  };
}
