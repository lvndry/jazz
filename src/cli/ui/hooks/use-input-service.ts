import { Effect } from "effect";
import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { ParsedInput } from "../../input/escape-state-machine";
import type { InputHandler, InputResult, InputService } from "../../services/input-service";
import { InputPriority, InputResults } from "../../services/input-service";
import { InputServiceContext } from "../contexts/InputContext";

// ============================================================================
// Service Access Hook
// ============================================================================

/**
 * Get the InputService from context.
 * Throws if used outside of InputProvider.
 */
export function useInputService(): InputService {
  const service = useContext(InputServiceContext);
  if (!service) {
    throw new Error("useInputService must be used within an InputProvider");
  }
  return service;
}

// ============================================================================
// Input Handler Hook
// ============================================================================

interface UseInputHandlerOptions {
  /** Unique identifier for this handler */
  id: string;
  /** Priority level (use InputPriority constants) */
  priority: number;
  /** Whether the handler is currently active */
  isActive?: boolean;
  /** Handler function - return Consumed, Ignored, or Propagate */
  onInput: (action: ParsedInput) => InputResult | void;
  /** Dependencies that should trigger handler re-registration */
  deps?: readonly unknown[];
}

/**
 * Register an input handler with the InputService.
 *
 * The handler will be automatically unregistered when the component unmounts
 * or when dependencies change.
 *
 * @example
 * ```tsx
 * useInputHandler({
 *   id: "my-component",
 *   priority: InputPriority.PROMPT,
 *   isActive: isFocused,
 *   onInput: (action) => {
 *     if (action.type === "submit") {
 *       handleSubmit();
 *       return InputResults.consumed();
 *     }
 *     return InputResults.ignored();
 *   },
 *   deps: [handleSubmit],
 * });
 * ```
 */
export function useInputHandler(options: UseInputHandlerOptions): void {
  const service = useInputService();
  const { id, priority, isActive = true, onInput, deps = [] } = options;

  // Store handler in ref to avoid recreating on every render
  const handlerRef = useRef(onInput);
  handlerRef.current = onInput;

  // Store isActive in ref for the handler
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    const handler: InputHandler = {
      id,
      priority,
      isActive: () => isActiveRef.current,
      handle: (event) => {
        const result = handlerRef.current(event.action);
        return result ?? InputResults.ignored();
      },
    };

    const cleanup = Effect.runSync(service.registerHandler(handler));

    return cleanup;
  }, [service, id, priority, ...deps]);
}

// ============================================================================
// Specific Action Hooks
// ============================================================================

interface UseActionHandlerOptions {
  /** Unique identifier for this handler */
  id: string;
  /** Priority level */
  priority?: number;
  /** Whether the handler is active */
  isActive?: boolean;
  /** Callback when action is triggered */
  onAction: () => void;
  /** Dependencies */
  deps?: readonly unknown[];
}

/**
 * Handle submit action (Enter key).
 */
export function useSubmitHandler(
  options: Omit<UseActionHandlerOptions, "id"> & { id?: string },
): void {
  const {
    id = "submit-handler",
    priority = InputPriority.PROMPT,
    isActive = true,
    onAction,
    deps = [],
  } = options;

  useInputHandler({
    id,
    priority,
    isActive,
    onInput: (action) => {
      if (action.type === "submit") {
        onAction();
        return InputResults.consumed();
      }
      return InputResults.ignored();
    },
    deps: [onAction, ...deps],
  });
}

/**
 * Handle escape action.
 */
export function useEscapeHandler(
  options: Omit<UseActionHandlerOptions, "id"> & { id?: string },
): void {
  const {
    id = "escape-handler",
    priority = InputPriority.MODAL,
    isActive = true,
    onAction,
    deps = [],
  } = options;

  useInputHandler({
    id,
    priority,
    isActive,
    onInput: (action) => {
      if (action.type === "escape") {
        onAction();
        return InputResults.consumed();
      }
      return InputResults.ignored();
    },
    deps: [onAction, ...deps],
  });
}

/**
 * Handle tab action (for interrupt).
 */
export function useTabHandler(
  options: Omit<UseActionHandlerOptions, "id"> & { id?: string },
): void {
  const {
    id = "tab-handler",
    priority = InputPriority.GLOBAL_SHORTCUT,
    isActive = true,
    onAction,
    deps = [],
  } = options;

  useInputHandler({
    id,
    priority,
    isActive,
    onInput: (action) => {
      if (action.type === "tab") {
        onAction();
        return InputResults.consumed();
      }
      return InputResults.ignored();
    },
    deps: [onAction, ...deps],
  });
}

// ============================================================================
// Text Input Hook
// ============================================================================

interface UseTextInputOptions {
  /** Unique identifier */
  id: string;
  /** Whether input is active/focused */
  isActive: boolean;
  /** Callback when submitted */
  onSubmit: (value: string) => void;
  /** Optional word boundary functions */
  findPrevWordBoundary?: (text: string, cursor: number) => number;
  findNextWordBoundary?: (text: string, cursor: number) => number;
}

export interface UseTextInputResult {
  /** Current value for rendering */
  value: string;
  /** Current cursor position for rendering */
  cursor: number;
  /** Imperative setter for external updates (e.g., defaults, command suggestions) */
  setValue: (value: string, cursor?: number) => void;
}

/**
 * Complete text input handling hook.
 *
 * Handles all text editing operations: character input, deletion,
 * cursor movement, and line editing commands.
 * Uses the InputService text input store as the single source of truth.
 */
export function useTextInput(options: UseTextInputOptions): UseTextInputResult {
  const {
    id,
    isActive,
    onSubmit,
    findPrevWordBoundary = defaultFindPrevWordBoundary,
    findNextWordBoundary = defaultFindNextWordBoundary,
  } = options;

  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const service = useInputService();

  const getSnapshot = useCallback(() => service.getTextInputState(id), [service, id]);
  const subscribe = useCallback(
    (listener: () => void) => service.subscribeTextInputState(id, listener),
    [service, id],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback(
    (nextValue: string, nextCursor?: number) => {
      const cursor = typeof nextCursor === "number" ? nextCursor : nextValue.length;
      const clampedCursor = Math.max(0, Math.min(cursor, nextValue.length));
      service.setTextInputState(id, { value: nextValue, cursor: clampedCursor });
    },
    [service, id],
  );

  useInputHandler({
    id,
    priority: InputPriority.TEXT_INPUT,
    isActive,
    onInput: (action) => {
      const currentState = service.getTextInputState(id);
      const currentValue = currentState.value;
      const currentCursor = currentState.cursor;

      let nextValue = currentValue;
      let nextCursor = currentCursor;

      switch (action.type) {
        case "submit":
          onSubmitRef.current(currentValue);
          return InputResults.consumed();

        case "char":
          nextValue =
            currentValue.slice(0, currentCursor) + action.char + currentValue.slice(currentCursor);
          nextCursor = currentCursor + action.char.length;
          break;

        case "backspace":
          if (currentCursor > 0) {
            nextValue =
              currentValue.slice(0, currentCursor - 1) + currentValue.slice(currentCursor);
            nextCursor = currentCursor - 1;
          }
          break;

        case "delete-char-forward":
          if (currentCursor < currentValue.length) {
            nextValue =
              currentValue.slice(0, currentCursor) + currentValue.slice(currentCursor + 1);
          }
          break;

        case "left":
          nextCursor = Math.max(0, currentCursor - 1);
          break;

        case "right":
          nextCursor = Math.min(currentValue.length, currentCursor + 1);
          break;

        case "word-left":
          nextCursor = findPrevWordBoundary(currentValue, currentCursor);
          break;

        case "word-right":
          nextCursor = findNextWordBoundary(currentValue, currentCursor);
          break;

        case "up": {
          // In multi-line input, move cursor to the previous line
          // In single-line input, let other handlers (e.g. history) handle it
          if (!currentValue.includes("\n")) {
            return InputResults.ignored();
          }
          const upPrevNewline = currentValue.lastIndexOf("\n", currentCursor - 1);
          if (upPrevNewline === -1) {
            // Already on the first line
            return InputResults.ignored();
          }
          // Find the start of the current line and the offset within it
          const upCurrentLineStart = upPrevNewline + 1;
          const upOffsetInCurrentLine = currentCursor - upCurrentLineStart;
          // Find the start of the previous line
          const upPrevLineStart = currentValue.lastIndexOf("\n", upPrevNewline - 1) + 1;
          const upPrevLineLen = upPrevNewline - upPrevLineStart;
          // Move to same column offset in previous line, clamped to line length
          nextCursor = upPrevLineStart + Math.min(upOffsetInCurrentLine, upPrevLineLen);
          break;
        }

        case "down": {
          // In multi-line input, move cursor to the next line
          // In single-line input, let other handlers (e.g. history) handle it
          if (!currentValue.includes("\n")) {
            return InputResults.ignored();
          }
          const downNextNewline = currentValue.indexOf("\n", currentCursor);
          if (downNextNewline === -1) {
            // Already on the last line
            return InputResults.ignored();
          }
          // Find the start of the current line and the offset within it
          const downCurrentLineStart = currentValue.lastIndexOf("\n", currentCursor - 1) + 1;
          const downOffsetInCurrentLine = currentCursor - downCurrentLineStart;
          // Next line starts after the newline
          const downNextLineStart = downNextNewline + 1;
          // Find the end of the next line
          const downNextLineEnd = currentValue.indexOf("\n", downNextLineStart);
          const downNextLineLen =
            downNextLineEnd === -1
              ? currentValue.length - downNextLineStart
              : downNextLineEnd - downNextLineStart;
          // Move to same column offset in next line, clamped to line length
          nextCursor = downNextLineStart + Math.min(downOffsetInCurrentLine, downNextLineLen);
          break;
        }

        case "line-start": {
          // Move to start of current line (find preceding newline)
          const lineStartIdx = currentValue.lastIndexOf("\n", currentCursor - 1);
          nextCursor = lineStartIdx === -1 ? 0 : lineStartIdx + 1;
          break;
        }

        case "line-end": {
          // Move to end of current line (find next newline)
          const lineEndIdx = currentValue.indexOf("\n", currentCursor);
          nextCursor = lineEndIdx === -1 ? currentValue.length : lineEndIdx;
          break;
        }

        case "delete-word-back": {
          const boundary = findPrevWordBoundary(currentValue, currentCursor);
          nextValue = currentValue.slice(0, boundary) + currentValue.slice(currentCursor);
          nextCursor = boundary;
          break;
        }

        case "delete-word-forward": {
          const boundary = findNextWordBoundary(currentValue, currentCursor);
          nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(boundary);
          break;
        }

        case "kill-line-back": {
          // Kill from cursor to start of current line
          const killBackLineStart = currentValue.lastIndexOf("\n", currentCursor - 1);
          const killBackTo = killBackLineStart === -1 ? 0 : killBackLineStart + 1;
          nextValue = currentValue.slice(0, killBackTo) + currentValue.slice(currentCursor);
          nextCursor = killBackTo;
          break;
        }

        case "kill-line-forward": {
          // Kill from cursor to end of current line
          const killFwdLineEnd = currentValue.indexOf("\n", currentCursor);
          const killFwdTo = killFwdLineEnd === -1 ? currentValue.length : killFwdLineEnd;
          nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(killFwdTo);
          break;
        }

        default:
          return InputResults.ignored();
      }

      // Update if changed
      if (nextValue !== currentValue || nextCursor !== currentCursor) {
        // Clamp cursor
        nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));
        service.setTextInputState(id, { value: nextValue, cursor: nextCursor });
      }

      return InputResults.consumed();
    },
    deps: [findPrevWordBoundary, findNextWordBoundary],
  });

  return {
    value: snapshot.value,
    cursor: snapshot.cursor,
    setValue,
  };
}

// ============================================================================
// Default Word Boundary Functions
// ============================================================================

function defaultFindPrevWordBoundary(text: string, cursor: number): number {
  if (cursor <= 0) return 0;

  let pos = cursor - 1;

  // Skip whitespace
  while (pos > 0 && /\s/.test(text[pos] ?? "")) {
    pos--;
  }

  // Skip word characters
  while (pos > 0 && /\w/.test(text[pos - 1] ?? "")) {
    pos--;
  }

  return pos;
}

function defaultFindNextWordBoundary(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;

  let pos = cursor;

  // Skip current word characters
  while (pos < text.length && /\w/.test(text[pos] ?? "")) {
    pos++;
  }

  // Skip whitespace
  while (pos < text.length && /\s/.test(text[pos] ?? "")) {
    pos++;
  }

  return pos;
}

// ============================================================================
// Re-exports
// ============================================================================

export { InputPriority, InputResults };
