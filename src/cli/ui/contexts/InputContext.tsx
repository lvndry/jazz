import { Effect } from "effect";
import { useInput } from "ink";
import React, { createContext, useCallback, useState } from "react";
import type { KeyInfo } from "../../input/escape-state-machine";
import { createInputService, type InputService } from "../../services/input-service";
import {
  TerminalCapabilityServiceLive,
  TerminalCapabilityServiceTag,
} from "../../services/terminal-service";

// ============================================================================
// Context
// ============================================================================

/**
 * Context for InputService.
 * null when not within a provider.
 */
export const InputServiceContext = createContext<InputService | null>(null);

// ============================================================================
// Provider Props
// ============================================================================

interface InputProviderProps {
  children: React.ReactNode;
  /** Optional pre-created service (for testing) */
  service?: InputService;
}

// ============================================================================
// Provider Component
// ============================================================================

/**
 * Provider component for InputService.
 *
 * Creates the InputService and sets up the Ink useInput bridge
 * to route all terminal input through the centralized service.
 *
 * @example
 * ```tsx
 * <InputProvider>
 *   <App />
 * </InputProvider>
 * ```
 */
export function InputProvider({
  children,
  service: providedService,
}: InputProviderProps): React.ReactElement {
  // Initialize service synchronously to ensure it's available on first render
  // This prevents children from rendering without the context
  const [service] = useState<InputService>(() => {
    if (providedService) {
      return providedService;
    }

    // Create service with terminal capabilities synchronously
    const program = Effect.gen(function* () {
      const terminalService = yield* TerminalCapabilityServiceTag;
      const capabilities = yield* terminalService.capabilities;
      return createInputService(capabilities);
    });

    return Effect.runSync(Effect.provide(program, TerminalCapabilityServiceLive));
  });

  // Bridge Ink's useInput to our InputService
  const handleInput = useCallback(
    (input: string, key: InkKey) => {
      // Convert Ink key to our KeyInfo
      const keyInfo: KeyInfo = {
        upArrow: key.upArrow ?? false,
        downArrow: key.downArrow ?? false,
        leftArrow: key.leftArrow ?? false,
        rightArrow: key.rightArrow ?? false,
        return: key.return ?? false,
        escape: key.escape ?? false,
        ctrl: key.ctrl ?? false,
        shift: key.shift ?? false,
        tab: key.tab ?? false,
        backspace: key.backspace ?? false,
        delete: key.delete ?? false,
        meta: key.meta ?? false,
      };

      // Process through service (fire and forget)
      Effect.runSync(service.processInput(input, keyInfo));
    },
    [service],
  );

  // Register with Ink's input system
  useInput(handleInput);

  return <InputServiceContext.Provider value={service}>{children}</InputServiceContext.Provider>;
}

// ============================================================================
// Ink Key Type (from ink's useInput)
// ============================================================================

interface InkKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
}

// ============================================================================
// HOC for Class Components
// ============================================================================

/**
 * Higher-order component to inject InputService into class components.
 */
export function withInputService<P extends { inputService: InputService }>(
  Component: React.ComponentType<P>,
): React.FC<Omit<P, "inputService">> {
  return function WithInputService(props: Omit<P, "inputService">) {
    return (
      <InputServiceContext.Consumer>
        {(service) => {
          if (!service) {
            throw new Error("withInputService must be used within an InputProvider");
          }
          return (
            <Component
              {...(props as P)}
              inputService={service}
            />
          );
        }}
      </InputServiceContext.Consumer>
    );
  };
}
