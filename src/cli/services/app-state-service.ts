import { Context, Effect, Layer, Ref } from "effect";
import type { LogEntry, LogEntryInput, LiveStreamState, PromptState } from "../ui/types";

// ============================================================================
// Types
// ============================================================================

/**
 * Complete application state.
 */
export interface AppState {
  readonly logs: ReadonlyArray<LogEntry>;
  readonly prompt: PromptState | null;
  readonly status: string | null;
  readonly stream: LiveStreamState | null;
  readonly workingDirectory: string | null;
  readonly customView: unknown | null;
}

/**
 * Subscription callback types for granular updates.
 */
export type LogsSubscriber = (logs: ReadonlyArray<LogEntry>) => void;
export type PromptSubscriber = (prompt: PromptState | null) => void;
export type StatusSubscriber = (status: string | null) => void;
export type StreamSubscriber = (stream: LiveStreamState | null) => void;
export type WorkingDirectorySubscriber = (workingDirectory: string | null) => void;
export type CustomViewSubscriber = (customView: unknown | null) => void;

/**
 * Unsubscribe function returned by subscribe methods.
 */
export type Unsubscribe = () => void;

/**
 * App State Service interface.
 *
 * Provides granular state management with selective subscriptions
 * to minimize React re-renders.
 */
export interface AppStateService {
  // -------------------------------------------------------------------------
  // State Access
  // -------------------------------------------------------------------------

  /** Get the complete current state */
  readonly get: Effect.Effect<AppState>;

  /** Get the underlying Ref for advanced usage */
  readonly getRef: Effect.Effect<Ref.Ref<AppState>>;

  // -------------------------------------------------------------------------
  // Logs Management
  // -------------------------------------------------------------------------

  /** Get current logs */
  readonly getLogs: Effect.Effect<ReadonlyArray<LogEntry>>;

  /** Add a new log entry, returns the assigned ID */
  readonly addLog: (entry: LogEntryInput) => Effect.Effect<string>;

  /** Update an existing log entry by ID */
  readonly updateLog: (id: string, updates: Partial<LogEntryInput>) => Effect.Effect<void>;

  /** Clear all logs */
  readonly clearLogs: Effect.Effect<void>;

  /** Subscribe to log changes */
  readonly subscribeLogs: (callback: LogsSubscriber) => Effect.Effect<Unsubscribe>;

  // -------------------------------------------------------------------------
  // Prompt Management
  // -------------------------------------------------------------------------

  /** Get current prompt */
  readonly getPrompt: Effect.Effect<PromptState | null>;

  /** Set the current prompt */
  readonly setPrompt: (prompt: PromptState | null) => Effect.Effect<void>;

  /** Subscribe to prompt changes */
  readonly subscribePrompt: (callback: PromptSubscriber) => Effect.Effect<Unsubscribe>;

  // -------------------------------------------------------------------------
  // Status Management
  // -------------------------------------------------------------------------

  /** Get current status */
  readonly getStatus: Effect.Effect<string | null>;

  /** Set the current status */
  readonly setStatus: (status: string | null) => Effect.Effect<void>;

  /** Subscribe to status changes */
  readonly subscribeStatus: (callback: StatusSubscriber) => Effect.Effect<Unsubscribe>;

  // -------------------------------------------------------------------------
  // Stream Management
  // -------------------------------------------------------------------------

  /** Get current stream state */
  readonly getStream: Effect.Effect<LiveStreamState | null>;

  /** Set the current stream state */
  readonly setStream: (stream: LiveStreamState | null) => Effect.Effect<void>;

  /** Subscribe to stream changes */
  readonly subscribeStream: (callback: StreamSubscriber) => Effect.Effect<Unsubscribe>;

  // -------------------------------------------------------------------------
  // Working Directory Management
  // -------------------------------------------------------------------------

  /** Get current working directory */
  readonly getWorkingDirectory: Effect.Effect<string | null>;

  /** Set the current working directory */
  readonly setWorkingDirectory: (workingDirectory: string | null) => Effect.Effect<void>;

  /** Subscribe to working directory changes */
  readonly subscribeWorkingDirectory: (
    callback: WorkingDirectorySubscriber,
  ) => Effect.Effect<Unsubscribe>;

  // -------------------------------------------------------------------------
  // Custom View Management
  // -------------------------------------------------------------------------

  /** Get current custom view */
  readonly getCustomView: Effect.Effect<unknown | null>;

  /** Set the current custom view */
  readonly setCustomView: (customView: unknown | null) => Effect.Effect<void>;

  /** Subscribe to custom view changes */
  readonly subscribeCustomView: (callback: CustomViewSubscriber) => Effect.Effect<Unsubscribe>;

  // -------------------------------------------------------------------------
  // Interrupt Handler
  // -------------------------------------------------------------------------

  /** Set the interrupt handler (called on Ctrl+C / Tab) */
  readonly setInterruptHandler: (handler: (() => void) | null) => Effect.Effect<void>;

  /** Get the current interrupt handler */
  readonly getInterruptHandler: Effect.Effect<(() => void) | null>;

  /** Trigger the interrupt handler if set */
  readonly triggerInterrupt: Effect.Effect<void>;
}

export const AppStateServiceTag = Context.GenericTag<AppStateService>("AppStateService");

// ============================================================================
// Configuration
// ============================================================================

/** Maximum number of log entries to keep */
const MAX_LOG_ENTRIES = 100;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create the App State Service.
 */
export function createAppStateService(): Effect.Effect<AppStateService, never, never> {
  return Effect.gen(function* () {
    // Initialize state ref
    const stateRef = yield* Ref.make<AppState>({
      logs: [],
      prompt: null,
      status: null,
      stream: null,
      workingDirectory: null,
      customView: null,
    });

    // Subscriber sets for each state slice
    const logsSubscribers = new Set<LogsSubscriber>();
    const promptSubscribers = new Set<PromptSubscriber>();
    const statusSubscribers = new Set<StatusSubscriber>();
    const streamSubscribers = new Set<StreamSubscriber>();
    const workingDirectorySubscribers = new Set<WorkingDirectorySubscriber>();
    const customViewSubscribers = new Set<CustomViewSubscriber>();

    // Interrupt handler ref
    let interruptHandler: (() => void) | null = null;

    // Log ID counter
    let logIdCounter = 0;

    /**
     * Notify subscribers of a state slice change.
     */
    function notifyLogsSubscribers(logs: ReadonlyArray<LogEntry>): void {
      for (const subscriber of logsSubscribers) {
        try {
          subscriber(logs);
        } catch {
          // Ignore subscriber errors
        }
      }
    }

    function notifyPromptSubscribers(prompt: PromptState | null): void {
      for (const subscriber of promptSubscribers) {
        try {
          subscriber(prompt);
        } catch {
          // Ignore subscriber errors
        }
      }
    }

    function notifyStatusSubscribers(status: string | null): void {
      for (const subscriber of statusSubscribers) {
        try {
          subscriber(status);
        } catch {
          // Ignore subscriber errors
        }
      }
    }

    function notifyStreamSubscribers(stream: LiveStreamState | null): void {
      for (const subscriber of streamSubscribers) {
        try {
          subscriber(stream);
        } catch {
          // Ignore subscriber errors
        }
      }
    }

    function notifyWorkingDirectorySubscribers(workingDirectory: string | null): void {
      for (const subscriber of workingDirectorySubscribers) {
        try {
          subscriber(workingDirectory);
        } catch {
          // Ignore subscriber errors
        }
      }
    }

    function notifyCustomViewSubscribers(customView: unknown | null): void {
      for (const subscriber of customViewSubscribers) {
        try {
          subscriber(customView);
        } catch {
          // Ignore subscriber errors
        }
      }
    }

    /**
     * Check if two stream states are equal (for optimization).
     */
    function streamsEqual(a: LiveStreamState | null, b: LiveStreamState | null): boolean {
      if (a === b) return true;
      if (!a || !b) return false;
      return a.agentName === b.agentName && a.text === b.text && a.reasoning === b.reasoning;
    }

    return {
      // State Access
      get: Ref.get(stateRef),
      getRef: Effect.succeed(stateRef),

      // Logs Management
      getLogs: Effect.map(Ref.get(stateRef), (state) => state.logs),

      addLog: (entry: LogEntryInput) =>
        Effect.gen(function* () {
          const id = entry.id ?? `log-${++logIdCounter}`;
          const newEntry: LogEntry = { ...entry, id };

          yield* Ref.update(stateRef, (state) => {
            // Check if updating existing log
            if (entry.id && state.logs.some((log) => log.id === entry.id)) {
              return {
                ...state,
                logs: state.logs.map((log) =>
                  log.id === entry.id ? { ...log, ...entry, id } : log,
                ),
              };
            }

            // Add new log with max limit
            let newLogs: ReadonlyArray<LogEntry>;
            if (state.logs.length >= MAX_LOG_ENTRIES) {
              newLogs = [...state.logs.slice(1), newEntry];
            } else {
              newLogs = [...state.logs, newEntry];
            }

            return { ...state, logs: newLogs };
          });

          const state = yield* Ref.get(stateRef);
          notifyLogsSubscribers(state.logs);

          return id;
        }),

      updateLog: (id: string, updates: Partial<LogEntryInput>) =>
        Effect.gen(function* () {
          let changed = false;

          yield* Ref.update(stateRef, (state) => {
            const newLogs = state.logs.map((log) => {
              if (log.id !== id) return log;

              const updated = { ...log, ...updates };
              // Check if actually changed
              if (
                log.type === updated.type &&
                log.message === updated.message &&
                log.timestamp === updated.timestamp &&
                log.meta === updated.meta
              ) {
                return log;
              }

              changed = true;
              return updated;
            });

            if (!changed) return state;
            return { ...state, logs: newLogs };
          });

          if (changed) {
            const state = yield* Ref.get(stateRef);
            notifyLogsSubscribers(state.logs);
          }
        }),

      clearLogs: Effect.gen(function* () {
        yield* Ref.update(stateRef, (state) => ({ ...state, logs: [] }));
        notifyLogsSubscribers([]);
      }),

      subscribeLogs: (callback: LogsSubscriber) =>
        Effect.sync(() => {
          logsSubscribers.add(callback);
          return () => {
            logsSubscribers.delete(callback);
          };
        }),

      // Prompt Management
      getPrompt: Effect.map(Ref.get(stateRef), (state) => state.prompt),

      setPrompt: (prompt: PromptState | null) =>
        Effect.gen(function* () {
          const prev = yield* Effect.map(Ref.get(stateRef), (s) => s.prompt);
          if (prev === prompt) return;

          yield* Ref.update(stateRef, (state) => ({ ...state, prompt }));
          notifyPromptSubscribers(prompt);
        }),

      subscribePrompt: (callback: PromptSubscriber) =>
        Effect.sync(() => {
          promptSubscribers.add(callback);
          return () => {
            promptSubscribers.delete(callback);
          };
        }),

      // Status Management
      getStatus: Effect.map(Ref.get(stateRef), (state) => state.status),

      setStatus: (status: string | null) =>
        Effect.gen(function* () {
          const prev = yield* Effect.map(Ref.get(stateRef), (s) => s.status);
          if (prev === status) return;

          yield* Ref.update(stateRef, (state) => ({ ...state, status }));
          notifyStatusSubscribers(status);
        }),

      subscribeStatus: (callback: StatusSubscriber) =>
        Effect.sync(() => {
          statusSubscribers.add(callback);
          return () => {
            statusSubscribers.delete(callback);
          };
        }),

      // Stream Management
      getStream: Effect.map(Ref.get(stateRef), (state) => state.stream),

      setStream: (stream: LiveStreamState | null) =>
        Effect.gen(function* () {
          const prev = yield* Effect.map(Ref.get(stateRef), (s) => s.stream);
          if (streamsEqual(prev, stream)) return;

          yield* Ref.update(stateRef, (state) => ({ ...state, stream }));
          notifyStreamSubscribers(stream);
        }),

      subscribeStream: (callback: StreamSubscriber) =>
        Effect.sync(() => {
          streamSubscribers.add(callback);
          return () => {
            streamSubscribers.delete(callback);
          };
        }),

      // Working Directory Management
      getWorkingDirectory: Effect.map(Ref.get(stateRef), (state) => state.workingDirectory),

      setWorkingDirectory: (workingDirectory: string | null) =>
        Effect.gen(function* () {
          const prev = yield* Effect.map(Ref.get(stateRef), (s) => s.workingDirectory);
          if (prev === workingDirectory) return;

          yield* Ref.update(stateRef, (state) => ({ ...state, workingDirectory }));
          notifyWorkingDirectorySubscribers(workingDirectory);
        }),

      subscribeWorkingDirectory: (callback: WorkingDirectorySubscriber) =>
        Effect.sync(() => {
          workingDirectorySubscribers.add(callback);
          return () => {
            workingDirectorySubscribers.delete(callback);
          };
        }),

      // Custom View Management
      getCustomView: Effect.map(Ref.get(stateRef), (state) => state.customView),

      setCustomView: (customView: unknown | null) =>
        Effect.gen(function* () {
          const prev = yield* Effect.map(Ref.get(stateRef), (s) => s.customView);
          if (prev === customView) return;

          yield* Ref.update(stateRef, (state) => ({ ...state, customView }));
          notifyCustomViewSubscribers(customView);
        }),

      subscribeCustomView: (callback: CustomViewSubscriber) =>
        Effect.sync(() => {
          customViewSubscribers.add(callback);
          return () => {
            customViewSubscribers.delete(callback);
          };
        }),

      // Interrupt Handler
      setInterruptHandler: (handler: (() => void) | null) =>
        Effect.sync(() => {
          interruptHandler = handler;
        }),

      getInterruptHandler: Effect.sync(() => interruptHandler),

      triggerInterrupt: Effect.sync(() => {
        if (interruptHandler) {
          interruptHandler();
        }
      }),
    };
  });
}

// ============================================================================
// Layer
// ============================================================================

/**
 * App State Service Layer.
 */
export const AppStateServiceLive = Layer.effect(AppStateServiceTag, createAppStateService());

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a log entry with the current timestamp.
 */
export function createLogEntry(
  type: LogEntry["type"],
  message: LogEntry["message"],
  meta?: Record<string, unknown>,
): LogEntryInput {
  const entry: LogEntryInput = {
    type,
    message,
    timestamp: new Date(),
  };
  if (meta !== undefined) {
    entry.meta = meta;
  }
  return entry;
}
