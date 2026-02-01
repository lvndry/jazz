import { Context, Effect, Layer } from "effect";
import {
  TerminalCapabilityServiceTag,
  type TerminalCapabilities,
} from "./terminal-service";
import {
  createEscapeStateMachine,
  type KeyInfo,
  type ParsedInput,
} from "../input/escape-state-machine";

// ============================================================================
// Types
// ============================================================================

/**
 * Input event containing both raw input and parsed action.
 */
export interface InputEvent {
  /** Raw input string from terminal */
  readonly rawInput: string;
  /** Key information from Ink's useInput */
  readonly key: KeyInfo;
  /** Parsed action from escape state machine */
  readonly action: ParsedInput;
  /** Timestamp when the input was received */
  readonly timestamp: number;
}

/**
 * Result of handling an input event.
 */
export type InputResult =
  | { readonly _tag: "Consumed" } // Handler fully processed the input
  | { readonly _tag: "Ignored" } // Handler doesn't care about this input
  | { readonly _tag: "Propagate" }; // Handler processed but wants others to also see it

/**
 * Input handler registration.
 */
export interface InputHandler {
  /** Unique identifier for this handler */
  readonly id: string;
  /** Priority (lower = higher priority, processed first) */
  readonly priority: number;
  /** Whether this handler is currently active */
  readonly isActive: () => boolean;
  /** Handle an input event */
  readonly handle: (event: InputEvent) => InputResult;
}

/**
 * Input service for centralized input handling.
 */
export interface InputService {
  /**
   * Register an input handler.
   * Returns a cleanup function to unregister.
   */
  readonly registerHandler: (handler: InputHandler) => Effect.Effect<() => void>;

  /**
   * Unregister a handler by ID.
   */
  readonly unregisterHandler: (id: string) => Effect.Effect<void>;

  /**
   * Process raw input from the terminal.
   * Routes through escape state machine and dispatches to handlers.
   */
  readonly processInput: (input: string, key: KeyInfo) => Effect.Effect<void>;

  /**
   * Get the current parsed action without dispatching to handlers.
   * Useful for preview/debugging.
   */
  readonly parseInput: (input: string, key: KeyInfo) => Effect.Effect<ParsedInput>;

  /**
   * Reset the escape state machine.
   * Call this when focus changes or prompts are dismissed.
   */
  readonly reset: Effect.Effect<void>;

  /**
   * Check if the state machine is buffering an escape sequence.
   */
  readonly isBuffering: Effect.Effect<boolean>;

  /**
   * Get all registered handler IDs (for debugging).
   */
  readonly getHandlerIds: Effect.Effect<readonly string[]>;
}

export const InputServiceTag = Context.GenericTag<InputService>("InputService");

// ============================================================================
// Priority Constants
// ============================================================================

/** Handler priority levels (lower = higher priority) */
export const InputPriority = {
  /** System-level handlers (Ctrl+C, etc.) */
  SYSTEM: 0,
  /** Modal handlers (confirmation dialogs, etc.) */
  MODAL: 10,
  /** Prompt handlers (text input, select, etc.) */
  PROMPT: 20,
  /** Global shortcuts (Tab interrupt, etc.) */
  GLOBAL_SHORTCUT: 30,
  /** Default priority for text input */
  TEXT_INPUT: 100,
  /** Lowest priority - catch-all handlers */
  FALLBACK: 1000,
} as const;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create the Input Service.
 *
 * Requires TerminalCapabilityService for terminal-aware escape sequence parsing.
 */
export function createInputService(
  terminalCapabilities: TerminalCapabilities,
): InputService {
  // Create escape state machine with terminal capabilities
  const stateMachine = createEscapeStateMachine(terminalCapabilities);

  // Handler registry - using a Map for O(1) lookup
  const handlers = new Map<string, InputHandler>();

  // Sorted handler list - rebuilt when handlers change
  let sortedHandlers: InputHandler[] = [];
  let handlersDirty = true;

  /**
   * Rebuild the sorted handlers list.
   */
  function rebuildSortedHandlers(): void {
    sortedHandlers = Array.from(handlers.values()).sort(
      (a, b) => a.priority - b.priority,
    );
    handlersDirty = false;
  }

  /**
   * Get sorted handlers, rebuilding if necessary.
   */
  function getSortedHandlers(): InputHandler[] {
    if (handlersDirty) {
      rebuildSortedHandlers();
    }
    return sortedHandlers;
  }

  return {
    registerHandler: (handler: InputHandler) =>
      Effect.sync(() => {
        // Check for duplicate ID
        if (handlers.has(handler.id)) {
          // Replace existing handler
          handlers.delete(handler.id);
        }

        handlers.set(handler.id, handler);
        handlersDirty = true;

        // Return cleanup function
        return () => {
          handlers.delete(handler.id);
          handlersDirty = true;
        };
      }),

    unregisterHandler: (id: string) =>
      Effect.sync(() => {
        handlers.delete(id);
        handlersDirty = true;
      }),

    processInput: (input: string, key: KeyInfo) =>
      Effect.gen(function* () {
        // Parse input through escape state machine
        const action = yield* stateMachine.process(input, key);

        // Skip if still buffering escape sequence
        if (action.type === "ignore") {
          const buffering = yield* stateMachine.isBuffering;
          if (buffering) {
            return; // Wait for more input
          }
        }

        // Create input event
        const event: InputEvent = {
          rawInput: input,
          key,
          action,
          timestamp: Date.now(),
        };

        // Dispatch to handlers in priority order
        for (const handler of getSortedHandlers()) {
          // Skip inactive handlers
          if (!handler.isActive()) {
            continue;
          }

          const result = handler.handle(event);

          // If consumed, stop propagation
          if (result._tag === "Consumed") {
            break;
          }

          // If ignored, continue to next handler
          // If propagate, continue but the handler did process it
        }
      }),

    parseInput: (input: string, key: KeyInfo) => stateMachine.process(input, key),

    reset: stateMachine.reset,

    isBuffering: stateMachine.isBuffering,

    getHandlerIds: Effect.sync(() => Array.from(handlers.keys())),
  };
}

// ============================================================================
// Layer
// ============================================================================

/**
 * Input Service Layer - requires TerminalCapabilityService.
 */
export const InputServiceLive = Layer.effect(
  InputServiceTag,
  Effect.gen(function* () {
    const terminalService = yield* TerminalCapabilityServiceTag;
    const capabilities = yield* terminalService.capabilities;
    return createInputService(capabilities);
  }),
);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an input handler with common patterns.
 */
export function createInputHandler(config: {
  id: string;
  priority: number;
  isActive?: () => boolean;
  onAction?: (action: ParsedInput) => InputResult | null;
  onRawInput?: (input: string, key: KeyInfo) => InputResult | null;
}): InputHandler {
  return {
    id: config.id,
    priority: config.priority,
    isActive: config.isActive ?? (() => true),
    handle: (event) => {
      // Try action-based handler first
      if (config.onAction) {
        const result = config.onAction(event.action);
        if (result) return result;
      }

      // Try raw input handler
      if (config.onRawInput) {
        const result = config.onRawInput(event.rawInput, event.key);
        if (result) return result;
      }

      return { _tag: "Ignored" };
    },
  };
}

/**
 * Create a simple handler that consumes specific action types.
 */
export function createActionHandler(config: {
  id: string;
  priority: number;
  isActive?: () => boolean;
  actions: Record<ParsedInput["type"], (() => void) | undefined>;
}): InputHandler {
  return {
    id: config.id,
    priority: config.priority,
    isActive: config.isActive ?? (() => true),
    handle: (event) => {
      const handler = config.actions[event.action.type];
      if (handler) {
        handler();
        return { _tag: "Consumed" };
      }
      return { _tag: "Ignored" };
    },
  };
}

// ============================================================================
// Input Result Helpers
// ============================================================================

export const InputResults = {
  consumed: (): InputResult => ({ _tag: "Consumed" }),
  ignored: (): InputResult => ({ _tag: "Ignored" }),
  propagate: (): InputResult => ({ _tag: "Propagate" }),
} as const;
