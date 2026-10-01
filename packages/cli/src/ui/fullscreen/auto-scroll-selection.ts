/**
 * Selection-edge scrolling through the shell's single viewport navigation port.
 * Dragging starts one bounded timer; drag-end, document/geometry changes that
 * disable selection, and unmount cancel it. The timer never owns scroll/follow
 * state or talks directly to a renderer/Transcript instance.
 */
import type { MouseEvent as OTMouseEvent } from "@opentui/core";
import { useCallback, useLayoutEffect, useRef } from "react";

const AUTO_SCROLL_INTERVAL_MS = 50;
const EDGE_THRESHOLD_ROWS = 2;

export function useAutoScrollOnDrag(
  scrollBy: (delta: number, unit?: "line" | "page" | "end") => void,
  transcriptTop: number,
  transcriptHeight: number,
  enabled: boolean,
  documentId: string,
): {
  onMouseDrag: (event: OTMouseEvent) => void;
  onMouseDragEnd: () => void;
} {
  const committed = useRef({ scrollBy, transcriptTop, transcriptHeight, enabled });
  useLayoutEffect(() => {
    committed.current = { scrollBy, transcriptTop, transcriptHeight, enabled };
  }, [scrollBy, transcriptTop, transcriptHeight, enabled]);
  const state = useRef<{ timer: ReturnType<typeof setInterval> | undefined; lastY: number }>({
    timer: undefined,
    lastY: 0,
  });
  const stop = useCallback(() => {
    if (state.current.timer !== undefined) clearInterval(state.current.timer);
    state.current.timer = undefined;
  }, []);
  useLayoutEffect(() => stop, [stop, documentId]);
  useLayoutEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);
  const tick = useCallback(() => {
    const {
      scrollBy: navigate,
      transcriptTop: top,
      transcriptHeight: height,
      enabled: active,
    } = committed.current;
    if (!active || height <= 0) {
      stop();
      return;
    }
    const y = state.current.lastY;
    const bottom = top + height - 1;
    if (y < top + EDGE_THRESHOLD_ROWS) {
      navigate(-(top + EDGE_THRESHOLD_ROWS - y > EDGE_THRESHOLD_ROWS ? 3 : 1), "line");
    } else if (y > bottom - EDGE_THRESHOLD_ROWS) {
      navigate(y - bottom + EDGE_THRESHOLD_ROWS > EDGE_THRESHOLD_ROWS ? 3 : 1, "line");
    }
  }, [stop]);
  const onMouseDrag = useCallback(
    (event: OTMouseEvent) => {
      if (!committed.current.enabled) return;
      state.current.lastY = event.y;
      if (state.current.timer === undefined) {
        state.current.timer = setInterval(tick, AUTO_SCROLL_INTERVAL_MS);
        tick();
      }
    },
    [tick],
  );
  return { onMouseDrag, onMouseDragEnd: stop };
}
