import { Effect } from "effect";
import React, { createContext, useEffect, useMemo, useState } from "react";
import {
  TerminalCapabilityServiceLive,
  TerminalCapabilityServiceTag,
  type TerminalCapabilities,
  type TerminalCapabilityService,
} from "../../services/terminal-service";

// ============================================================================
// Context
// ============================================================================

/**
 * Context for TerminalCapabilityService.
 * null when not within a provider.
 */
export const TerminalServiceContext = createContext<TerminalCapabilityService | null>(null);

/**
 * Context for terminal capabilities (for components that only need static caps).
 */
export const TerminalCapabilitiesContext = createContext<TerminalCapabilities | null>(null);

// ============================================================================
// Provider Props
// ============================================================================

interface TerminalProviderProps {
  children: React.ReactNode;
  /** Optional pre-created service (for testing) */
  service?: TerminalCapabilityService;
}

// ============================================================================
// Provider Component
// ============================================================================

/**
 * Provider component for TerminalCapabilityService.
 *
 * Detects terminal capabilities on mount and provides them to all children.
 *
 * @example
 * ```tsx
 * <TerminalProvider>
 *   <App />
 * </TerminalProvider>
 * ```
 */
export function TerminalProvider({
  children,
  service: providedService,
}: TerminalProviderProps): React.ReactElement {
  const [service, setService] = useState<TerminalCapabilityService | null>(providedService ?? null);
  const [capabilities, setCapabilities] = useState<TerminalCapabilities | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Initialize service on mount
  useEffect(() => {
    if (providedService) {
      setService(providedService);
      // Get capabilities from provided service
      try {
        const caps = Effect.runSync(providedService.capabilities);
        setCapabilities(caps);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    // Create service from layer
    try {
      const createdService = Effect.runSync(
        Effect.gen(function* () {
          return yield* TerminalCapabilityServiceTag;
        }).pipe(Effect.provide(TerminalCapabilityServiceLive)),
      );

      setService(createdService);

      // Get initial capabilities
      const caps = Effect.runSync(createdService.capabilities);
      setCapabilities(caps);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [providedService]);

  // Memoize context values
  const serviceValue = useMemo(() => service, [service]);
  const capsValue = useMemo(() => capabilities, [capabilities]);

  if (error) {
    throw error;
  }

  if (!service || !capabilities) {
    // Service is being created
    return <>{children}</>;
  }

  return (
    <TerminalServiceContext.Provider value={serviceValue}>
      <TerminalCapabilitiesContext.Provider value={capsValue}>
        {children}
      </TerminalCapabilitiesContext.Provider>
    </TerminalServiceContext.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Get terminal capabilities.
 * Throws if used outside of TerminalProvider.
 */
export function useTerminalCapabilities(): TerminalCapabilities {
  const caps = React.useContext(TerminalCapabilitiesContext);
  if (!caps) {
    throw new Error("useTerminalCapabilities must be used within a TerminalProvider");
  }
  return caps;
}

/**
 * Get the TerminalCapabilityService.
 * Throws if used outside of TerminalProvider.
 */
export function useTerminalService(): TerminalCapabilityService {
  const service = React.useContext(TerminalServiceContext);
  if (!service) {
    throw new Error("useTerminalService must be used within a TerminalProvider");
  }
  return service;
}

/**
 * Get the detected terminal type.
 */
export function useTerminalType(): TerminalCapabilities["type"] {
  return useTerminalCapabilities().type;
}

/**
 * Check if terminal supports a feature.
 */
export function useTerminalSupports(feature: "unicode" | "trueColor" | "hyperlinks"): boolean {
  const caps = useTerminalCapabilities();
  switch (feature) {
    case "unicode":
      return caps.supportsUnicode;
    case "trueColor":
      return caps.supportsTrueColor;
    case "hyperlinks":
      return caps.supportsHyperlinks;
  }
}
