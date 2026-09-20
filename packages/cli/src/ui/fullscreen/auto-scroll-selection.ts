import type { MouseEvent as OTMouseEvent } from "@opentui/core";
import { useCallback, useRef } from "react";
import type { TranscriptHandle } from "./Transcript";

const AUTO_SCROLL_INTERVAL_MS = 50;
const EDGE_THRESHOLD_ROWS = 2;
const SCROLL_SPEED_SLOW = 1;
const SCROLL_SPEED_FAST = 3;

interface ScrollOnDragState {
  timer: ReturnType<typeof setInterval> | undefined;
  lastY: number;
}

export function useAutoScrollOnDrag(
  transcriptRef: React.RefObject<TranscriptHandle | null>,
  transcriptTop: number,
  transcriptHeight: number,
): {
  onMouseDrag: (event: OTMouseEvent) => void;
  onMouseDragEnd: () => void;
} {
  const transcriptTopRef = useRef(transcriptTop);
  const transcriptHeightRef = useRef(transcriptHeight);
  transcriptTopRef.current = transcriptTop;
  transcriptHeightRef.current = transcriptHeight;

  const state = useRef<ScrollOnDragState>({ timer: undefined, lastY: 0 });

  const scrollTick = useCallback(() => {
    const focusY = state.current.lastY;
    const top = transcriptTopRef.current;
    const height = transcriptHeightRef.current;
    if (height <= 0) return;
    const bottom = top + height - 1;

    if (focusY < top + EDGE_THRESHOLD_ROWS) {
      const distance = top + EDGE_THRESHOLD_ROWS - focusY;
      const speed = distance > EDGE_THRESHOLD_ROWS ? SCROLL_SPEED_FAST : SCROLL_SPEED_SLOW;
      transcriptRef.current?.scrollBy(-speed, "line");
    } else if (focusY > bottom - EDGE_THRESHOLD_ROWS) {
      const distance = focusY - (bottom - EDGE_THRESHOLD_ROWS);
      const speed = distance > EDGE_THRESHOLD_ROWS ? SCROLL_SPEED_FAST : SCROLL_SPEED_SLOW;
      transcriptRef.current?.scrollBy(speed, "line");
    }
  }, [transcriptRef]);

  const stopTimer = useCallback(() => {
    if (state.current.timer !== undefined) {
      clearInterval(state.current.timer);
      state.current.timer = undefined;
    }
  }, []);

  const onMouseDrag = useCallback(
    (event: OTMouseEvent) => {
      state.current.lastY = event.y;
      if (state.current.timer === undefined) {
        scrollTick();
        state.current.timer = setInterval(scrollTick, AUTO_SCROLL_INTERVAL_MS);
      }
    },
    [scrollTick],
  );

  const onMouseDragEnd = useCallback(() => {
    stopTimer();
  }, [stopTimer]);

  return { onMouseDrag, onMouseDragEnd };
}
