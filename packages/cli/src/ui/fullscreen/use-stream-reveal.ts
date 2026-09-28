import { useEffect, useRef, useState } from "react";
import {
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
 */
export function useStreamReveal(target: string, clock: () => number = Date.now): string {
  const state = useRef<RevealState>(initialReveal(clock()));
  const [, repaint] = useState(0);
  state.current = receiveTarget(state.current, target, clock());

  useEffect(() => {
    if (!isRevealing(state.current)) return;
    const timer = setInterval(() => {
      const previous = state.current;
      const next = stepReveal(previous, clock());
      state.current = next;
      if (next.shown !== previous.shown) repaint((frame) => frame + 1);
      if (!isRevealing(next)) clearInterval(timer);
    }, REVEAL_FRAME_MS);
    return () => clearInterval(timer);
  }, [target, clock]);

  return revealedText(state.current);
}
