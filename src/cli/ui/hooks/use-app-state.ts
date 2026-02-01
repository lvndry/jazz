import { Effect } from "effect";
import { useCallback, useContext, useSyncExternalStore } from "react";
import type { AppStateService } from "../../services/app-state-service";
import { AppStateServiceContext } from "../contexts/AppStateContext";
import type { LogEntry, LiveStreamState, PromptState } from "../types";

// ============================================================================
// Service Access Hook
// ============================================================================

/**
 * Get the AppStateService from context.
 * Throws if used outside of AppStateProvider.
 */
export function useAppStateService(): AppStateService {
  const service = useContext(AppStateServiceContext);
  if (!service) {
    throw new Error("useAppStateService must be used within an AppStateProvider");
  }
  return service;
}

// ============================================================================
// Granular State Hooks
// ============================================================================

/**
 * Subscribe to logs state only.
 * Component will only re-render when logs change.
 */
export function useLogs(): ReadonlyArray<LogEntry> {
  const service = useAppStateService();

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribe = Effect.runSync(
        service.subscribeLogs(() => callback()),
      );
      return unsubscribe;
    },
    [service],
  );

  const getSnapshot = useCallback(
    () => Effect.runSync(service.getLogs),
    [service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to prompt state only.
 * Component will only re-render when prompt changes.
 */
export function usePrompt(): PromptState | null {
  const service = useAppStateService();

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribe = Effect.runSync(
        service.subscribePrompt(() => callback()),
      );
      return unsubscribe;
    },
    [service],
  );

  const getSnapshot = useCallback(
    () => Effect.runSync(service.getPrompt),
    [service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to status state only.
 * Component will only re-render when status changes.
 */
export function useStatus(): string | null {
  const service = useAppStateService();

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribe = Effect.runSync(
        service.subscribeStatus(() => callback()),
      );
      return unsubscribe;
    },
    [service],
  );

  const getSnapshot = useCallback(
    () => Effect.runSync(service.getStatus),
    [service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to stream state only.
 * Component will only re-render when stream changes.
 */
export function useStream(): LiveStreamState | null {
  const service = useAppStateService();

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribe = Effect.runSync(
        service.subscribeStream(() => callback()),
      );
      return unsubscribe;
    },
    [service],
  );

  const getSnapshot = useCallback(
    () => Effect.runSync(service.getStream),
    [service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to working directory state only.
 * Component will only re-render when working directory changes.
 */
export function useWorkingDirectory(): string | null {
  const service = useAppStateService();

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribe = Effect.runSync(
        service.subscribeWorkingDirectory(() => callback()),
      );
      return unsubscribe;
    },
    [service],
  );

  const getSnapshot = useCallback(
    () => Effect.runSync(service.getWorkingDirectory),
    [service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to custom view state only.
 * Component will only re-render when custom view changes.
 */
export function useCustomView(): unknown {
  const service = useAppStateService();

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsubscribe = Effect.runSync(
        service.subscribeCustomView(() => callback()),
      );
      return unsubscribe;
    },
    [service],
  );

  const getSnapshot = useCallback(
    () => Effect.runSync(service.getCustomView),
    [service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ============================================================================
// Action Hooks
// ============================================================================

/**
 * Get log management actions.
 */
export function useLogActions() {
  const service = useAppStateService();

  return {
    addLog: useCallback(
      (entry: Parameters<AppStateService["addLog"]>[0]) =>
        Effect.runSync(service.addLog(entry)),
      [service],
    ),
    updateLog: useCallback(
      (id: string, updates: Parameters<AppStateService["updateLog"]>[1]) =>
        Effect.runSync(service.updateLog(id, updates)),
      [service],
    ),
    clearLogs: useCallback(
      () => Effect.runSync(service.clearLogs),
      [service],
    ),
  };
}

/**
 * Get prompt management actions.
 */
export function usePromptActions() {
  const service = useAppStateService();

  return {
    setPrompt: useCallback(
      (prompt: PromptState | null) => Effect.runSync(service.setPrompt(prompt)),
      [service],
    ),
  };
}

/**
 * Get status management actions.
 */
export function useStatusActions() {
  const service = useAppStateService();

  return {
    setStatus: useCallback(
      (status: string | null) => Effect.runSync(service.setStatus(status)),
      [service],
    ),
  };
}

/**
 * Get stream management actions.
 */
export function useStreamActions() {
  const service = useAppStateService();

  return {
    setStream: useCallback(
      (stream: LiveStreamState | null) => Effect.runSync(service.setStream(stream)),
      [service],
    ),
  };
}

// ============================================================================
// Combined Hooks
// ============================================================================

/**
 * Get all state actions in one hook.
 * Useful for components that need to update multiple state slices.
 */
export function useAppStateActions() {
  const service = useAppStateService();

  return {
    // Logs
    addLog: useCallback(
      (entry: Parameters<AppStateService["addLog"]>[0]) =>
        Effect.runSync(service.addLog(entry)),
      [service],
    ),
    updateLog: useCallback(
      (id: string, updates: Parameters<AppStateService["updateLog"]>[1]) =>
        Effect.runSync(service.updateLog(id, updates)),
      [service],
    ),
    clearLogs: useCallback(
      () => Effect.runSync(service.clearLogs),
      [service],
    ),

    // Prompt
    setPrompt: useCallback(
      (prompt: PromptState | null) => Effect.runSync(service.setPrompt(prompt)),
      [service],
    ),

    // Status
    setStatus: useCallback(
      (status: string | null) => Effect.runSync(service.setStatus(status)),
      [service],
    ),

    // Stream
    setStream: useCallback(
      (stream: LiveStreamState | null) => Effect.runSync(service.setStream(stream)),
      [service],
    ),

    // Working Directory
    setWorkingDirectory: useCallback(
      (dir: string | null) => Effect.runSync(service.setWorkingDirectory(dir)),
      [service],
    ),

    // Custom View
    setCustomView: useCallback(
      (view: unknown) => Effect.runSync(service.setCustomView(view)),
      [service],
    ),

    // Interrupt
    setInterruptHandler: useCallback(
      (handler: (() => void) | null) =>
        Effect.runSync(service.setInterruptHandler(handler)),
      [service],
    ),
    triggerInterrupt: useCallback(
      () => Effect.runSync(service.triggerInterrupt),
      [service],
    ),
  };
}
