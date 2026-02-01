import { Effect } from "effect";
import React, { createContext, useEffect, useMemo, useState } from "react";
import {
  createAppStateService,
  type AppStateService,
} from "../../services/app-state-service";

// ============================================================================
// Context
// ============================================================================

/**
 * Context for AppStateService.
 * null when not within a provider.
 */
export const AppStateServiceContext = createContext<AppStateService | null>(null);

// ============================================================================
// Provider Props
// ============================================================================

interface AppStateProviderProps {
  children: React.ReactNode;
  /** Optional pre-created service (for testing or custom initialization) */
  service?: AppStateService;
}

// ============================================================================
// Provider Component
// ============================================================================

/**
 * Provider component for AppStateService.
 *
 * Creates and manages the AppStateService instance, making it available
 * to all child components via context.
 *
 * @example
 * ```tsx
 * <AppStateProvider>
 *   <App />
 * </AppStateProvider>
 * ```
 */
export function AppStateProvider({
  children,
  service: providedService,
}: AppStateProviderProps): React.ReactElement {
  // Create service on mount if not provided
  const [service, setService] = useState<AppStateService | null>(
    providedService ?? null,
  );
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (providedService) {
      setService(providedService);
      return;
    }

    // Create service asynchronously
    const program = createAppStateService();

    try {
      const createdService = Effect.runSync(program);
      setService(createdService);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [providedService]);

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo(() => service, [service]);

  if (error) {
    throw error;
  }

  if (!service) {
    // Service is being created
    return <>{children}</>;
  }

  return (
    <AppStateServiceContext.Provider value={contextValue}>
      {children}
    </AppStateServiceContext.Provider>
  );
}

// ============================================================================
// HOC for Class Components
// ============================================================================

/**
 * Higher-order component to inject AppStateService into class components.
 */
export function withAppStateService<P extends { appStateService: AppStateService }>(
  Component: React.ComponentType<P>,
): React.FC<Omit<P, "appStateService">> {
  return function WithAppStateService(props: Omit<P, "appStateService">) {
    return (
      <AppStateServiceContext.Consumer>
        {(service) => {
          if (!service) {
            throw new Error(
              "withAppStateService must be used within an AppStateProvider",
            );
          }
          return <Component {...(props as P)} appStateService={service} />;
        }}
      </AppStateServiceContext.Consumer>
    );
  };
}
