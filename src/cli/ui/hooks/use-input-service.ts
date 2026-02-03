import { Effect } from "effect";
import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { ParsedInput } from "../../input/escape-state-machine";
import type {
  InputHandler,
  InputResult,
  InputService,
} from "../../services/input-service";
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
export function useSubmitHandler(options: Omit<UseActionHandlerOptions, "id"> & { id?: string }): void {
  const { id = "submit-handler", priority = InputPriority.PROMPT, isActive = true, onAction, deps = [] } = options;

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
export function useEscapeHandler(options: Omit<UseActionHandlerOptions, "id"> & { id?: string }): void {
  const { id = "escape-handler", priority = InputPriority.MODAL, isActive = true, onAction, deps = [] } = options;

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
export function useTabHandler(options: Omit<UseActionHandlerOptions, "id"> & { id?: string }): void {
  const { id = "tab-handler", priority = InputPriority.GLOBAL_SHORTCUT, isActive = true, onAction, deps = [] } = options;

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

  const getSnapshot = useCallback(
    () => service.getTextInputState(id),
    [service, id],
  );
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
            currentValue.slice(0, currentCursor) +
            action.char +
            currentValue.slice(currentCursor);
          nextCursor = currentCursor + action.char.length;
          break;

        case "backspace":
          if (currentCursor > 0) {
            nextValue =
              currentValue.slice(0, currentCursor - 1) +
              currentValue.slice(currentCursor);
            nextCursor = currentCursor - 1;
          }
          break;

        case "delete-char-forward":
          if (currentCursor < currentValue.length) {
            nextValue =
              currentValue.slice(0, currentCursor) +
              currentValue.slice(currentCursor + 1);
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

        case "line-start":
          nextCursor = 0;
          break;

        case "line-end":
          nextCursor = currentValue.length;
          break;

        case "delete-word-back": {
          const boundary = findPrevWordBoundary(currentValue, currentCursor);
          nextValue =
            currentValue.slice(0, boundary) + currentValue.slice(currentCursor);
          nextCursor = boundary;
          break;
        }

        case "delete-word-forward": {
          const boundary = findNextWordBoundary(currentValue, currentCursor);
          nextValue =
            currentValue.slice(0, currentCursor) + currentValue.slice(boundary);
          break;
        }

        case "kill-line-back":
          nextValue = currentValue.slice(currentCursor);
          nextCursor = 0;
          break;

        case "kill-line-forward":
          nextValue = currentValue.slice(0, currentCursor);
          break;

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
