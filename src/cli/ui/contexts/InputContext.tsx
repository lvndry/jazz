import { Effect } from "effect";
import { useInput, useStdin } from "ink";
import React, { createContext, useCallback, useEffect, useRef, useState } from "react";
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

  // Track whether a paste was just handled so we can suppress
  // Ink's useInput for the same chunk (Ink strips pasted newlines).
  // A ref is used instead of state because the raw stdin listener and
  // Ink's useInput fire synchronously within the same event-loop tick;
  // a state update would only be visible after a re-render, causing the
  // suppression flag to be missed and the pasted content to be processed
  // twice.
  const suppressNextRef = useRef(false);

  const { stdin } = useStdin();

  // Intercept raw stdin to detect multi-line pastes.
  // Ink's parseKeypress treats \r as "return" and discards the rest,
  // so pasted multi-line text loses all content. We listen on the raw
  // stdin 'data' event (which fires before Ink processes the chunk)
  // and inject the text directly as a "char" action when we detect
  // a paste containing newlines.
  useEffect(() => {
    if (!stdin) return;

    const onData = (data: Buffer | string) => {
      const text = typeof data === "string" ? data : data.toString("utf8");

      // Detect a multi-line paste: contains \r\n or \n and has
      // content beyond just the line endings themselves.
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const hasNewlines = normalized.includes("\n");
      const hasContent = normalized.replace(/\n/g, "").length > 0;

      if (hasNewlines && hasContent) {
        // This is a pasted multi-line string. Inject it directly
        // as a char input, bypassing Ink's keypress parser.
        const charKey: KeyInfo = {
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
        Effect.runSync(service.processInput(normalized, charKey));
        // Tell useInput handler to skip the next call (same chunk)
        suppressNextRef.current = true;
      }
    };

    // Prepend listener so we see data before Ink's handler
    stdin.prependListener("data", onData);
    return () => {
      stdin.removeListener("data", onData);
    };
  }, [stdin, service]);

  // Bridge Ink's useInput to our InputService
  const handleInput = useCallback(
    (input: string, key: InkKey) => {
      // Skip if we already handled this chunk as a multi-line paste
      if (suppressNextRef.current) {
        suppressNextRef.current = false;
        return;
      }

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
