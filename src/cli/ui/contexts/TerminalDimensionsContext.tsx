/**
 * Terminal dimensions context — provides reactive cols/rows for layout.
 *
 * Subscribes to process.stdout resize events (debounced) so components
 * can re-wrap and re-layout when the terminal is resized.
 */

import React, { createContext, useContext, useEffect, useState } from "react";

const RESIZE_DEBOUNCE_MS = 150;

function getDimensions(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

const TerminalDimensionsContext = createContext<TerminalDimensions>(getDimensions());

export function useTerminalDimensions(): TerminalDimensions {
  return useContext(TerminalDimensionsContext);
}

export function TerminalDimensionsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [dimensions, setDimensions] = useState(getDimensions);

  useEffect(() => {
    const onResize = (): void => {
      setDimensions(getDimensions());
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const debouncedResize = (): void => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        onResize();
      }, RESIZE_DEBOUNCE_MS);
    };

    process.stdout.on("resize", debouncedResize);
    return () => {
      process.stdout.off("resize", debouncedResize);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  return (
    <TerminalDimensionsContext.Provider value={dimensions}>
      {children}
    </TerminalDimensionsContext.Provider>
  );
}
