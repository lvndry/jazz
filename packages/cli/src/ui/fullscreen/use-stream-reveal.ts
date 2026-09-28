import { useEffect, useRef, useState } from "react";
import {
  flushReveal,
  initialReveal,
  isRevealing,
  receiveTarget,
  revealedText,
  stepReveal,
  type RevealState,
} from "./stream-reveal";

/**
 * One reveal frame. 30fps is the rate at which prose stops reading as steps:
 * at a typical 60–120 characters per second a frame adds two to four
 * characters, about half a word. The renderer's frame cap has to allow it.
 */
export const REVEAL_FRAME_MS = 33;

/**
 * The part of the streaming text that should be on screen now.
 *
 * The frame loop runs only while there is a backlog, so a settled transcript
 * costs nothing. When the stream ends the store empties `target` and the
 * finished turn arrives whole as a settled block, which is the flush: nothing
 * of a completed or interrupted answer is ever held back.
 *
 * Pacing is for someone watching the answer arrive. While `paced` is false
 * (the reader has scrolled up, or an overlay covers the transcript) the whole
 * text is shown at once, so what they come back to is complete, and the frame
 * loop does not run for text nobody can see.
 */
export function useStreamReveal(
  target: string,
  paced = true,
  clock: () => number = Date.now,
): string {
  const state = useRef<RevealState>(initialReveal(clock()));
  const [, repaint] = useState(0);
  state.current = receiveTarget(state.current, target, clock());
  if (!paced && isRevealing(state.current)) {
    state.current = flushReveal(state.current, clock());
  }

  useEffect(() => {
    if (!paced || !isRevealing(state.current)) return;
    const timer = setInterval(() => {
      const previous = state.current;
      const next = stepReveal(previous, clock());
      state.current = next;
      if (next.shown !== previous.shown) repaint((frame) => frame + 1);
      if (!isRevealing(next)) clearInterval(timer);
    }, REVEAL_FRAME_MS);
    return () => clearInterval(timer);
  }, [target, paced, clock]);

  return revealedText(state.current);
}
