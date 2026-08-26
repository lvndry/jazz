import { Effect } from "effect";
import { useInput, useStdin } from "ink";
import React, { createContext, useCallback, useEffect, useRef, useState } from "react";
import { createInputService, type InputService } from "@/cli/services/input-service";
import {
  TerminalCapabilityServiceLive,
  TerminalCapabilityServiceTag,
} from "@/cli/services/terminal-service";
import type { KeyInfo } from "../../input/escape-state-machine";

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

  // Suppression window: after the raw-data listener consumes a paste chunk,
  // Ink's useInput still receives the same bytes (possibly split into several
  // keypress events). A single "skip next call" flag leaks the tail events,
  // so we suppress every useInput call inside a short wall-clock window
  // instead — no human keystroke lands within a few ms of a paste chunk.
  const suppressUntilRef = useRef(0);

  // Buffer for a bracketed paste that spans multiple stdin chunks
  // (non-null while inside ESC[200~ … ESC[201~).
  const pasteBufferRef = useRef<string | null>(null);

  const { stdin } = useStdin();

  // Intercept raw stdin to handle pastes.
  //
  // Bracketed paste mode (enabled below) wraps pasted bytes in
  // ESC[200~ … ESC[201~, letting us capture the exact paste content —
  // including single-line pastes and any newlines Ink's keypress parser
  // would otherwise swallow. The newline heuristic remains as a fallback
  // for terminals that don't support the mode.
  useEffect(() => {
    if (!stdin) return;

    const PASTE_START = "\u001b[200~";
    const PASTE_END = "\u001b[201~";
    const SUPPRESS_WINDOW_MS = 20;

    // Bytes held back because they might be the beginning of a paste marker
    // split across stdin chunk boundaries (e.g. one chunk ends with ESC and
    // the next begins with "[200~").
    let markerCarry = "";

    /** Longest suffix of `text` that is a proper prefix of a paste marker. */
    const partialMarkerSuffixLength = (text: string): number => {
      const maxLength = Math.min(text.length, PASTE_END.length - 1);
      for (let length = maxLength; length > 0; length--) {
        const suffix = text.slice(-length);
        if (PASTE_START.startsWith(suffix) || PASTE_END.startsWith(suffix)) return length;
      }
      return 0;
    };

    const injectPaste = (content: string): void => {
      const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (normalized.length === 0) return;
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
    };

    const onData = (data: Buffer | string) => {
      const chunk = typeof data === "string" ? data : data.toString("utf8");
      // Prepend any held-back bytes that could have been the start of a
      // marker split across chunk boundaries.
      const text = markerCarry + chunk;
      markerCarry = "";

      // Continuation of a bracketed paste from a previous chunk.
      if (pasteBufferRef.current !== null) {
        const endIndex = text.indexOf(PASTE_END);
        if (endIndex === -1) {
          // Hold back a possible partial end-marker so it can complete on
          // the next chunk instead of leaking into the paste content —
          // otherwise a split ESC[201~ would swallow input forever.
          const holdback = partialMarkerSuffixLength(text);
          pasteBufferRef.current += holdback > 0 ? text.slice(0, -holdback) : text;
          markerCarry = holdback > 0 ? text.slice(-holdback) : "";
        } else {
          const content = pasteBufferRef.current + text.slice(0, endIndex);
          pasteBufferRef.current = null;
          injectPaste(content);
          const remainder = text.slice(endIndex + PASTE_END.length);
          if (remainder.length > 0) onData(remainder);
        }
        suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
        return;
      }

      // Start of a bracketed paste.
      const startIndex = text.indexOf(PASTE_START);
      if (startIndex !== -1) {
        const afterStart = text.slice(startIndex + PASTE_START.length);
        const endIndex = afterStart.indexOf(PASTE_END);
        if (endIndex === -1) {
          const holdback = partialMarkerSuffixLength(afterStart);
          pasteBufferRef.current = holdback > 0 ? afterStart.slice(0, -holdback) : afterStart;
          markerCarry = holdback > 0 ? afterStart.slice(-holdback) : "";
        } else {
          injectPaste(afterStart.slice(0, endIndex));
          const remainder = afterStart.slice(endIndex + PASTE_END.length);
          if (remainder.length > 0) onData(remainder);
        }
        suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
        return;
      }

      // No marker found. If the chunk ends with a possible partial marker,
      // hold those bytes back so detection works across the boundary. This
      // only affects our detection — Ink still processes the raw chunk.
      const holdback = partialMarkerSuffixLength(text);
      if (holdback > 0) {
        markerCarry = text.slice(-holdback);
      }

      // Fallback heuristic for terminals without bracketed paste: a chunk
      // with newlines plus content is a multi-line paste.
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const hasNewlines = normalized.includes("\n");
      const hasContent = normalized.replace(/\n/g, "").length > 0;
      if (hasNewlines && hasContent) {
        injectPaste(normalized);
        suppressUntilRef.current = Date.now() + SUPPRESS_WINDOW_MS;
      }
    };

    // Prepend listener so we see data before Ink's handler
    stdin.prependListener("data", onData);

    // Ask the terminal to bracket pastes; restore on unmount AND on hard
    // process exit (crash/SIGINT paths skip React cleanup and would leave
    // the terminal in bracketed-paste mode).
    process.stdout.write("\u001b[?2004h");
    const restorePasteMode = (): void => {
      process.stdout.write("\u001b[?2004l");
    };
    process.on("exit", restorePasteMode);
    return () => {
      stdin.removeListener("data", onData);
      process.removeListener("exit", restorePasteMode);
      restorePasteMode();
    };
  }, [stdin, service]);

  // Bridge Ink's useInput to our InputService
  const handleInput = useCallback(
    (input: string, key: InkKey) => {
      // Skip events that belong to a paste chunk the raw listener consumed
      if (Date.now() < suppressUntilRef.current) {
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
