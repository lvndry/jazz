import { Text } from "ink";
import React, { useEffect, useState } from "react";
import { getGlyphs, laneFrame } from "../glyphs";
import { MOTION } from "../theme";

/**
 * Jazz's waiting animation: five lanes, each resting and then playing a
 * three-step burst on its own period.
 *
 * The point is that it can count. A generalist agent's characteristic state is
 * several things in flight at once — reaching into a mailbox, a search and a
 * calendar simultaneously — and a single rotating glyph cannot express that. A
 * longer period here means a longer rest, so the number of moving lanes tracks
 * how much work is actually happening.
 *
 * The lane periods are pairwise coprime, so the composite pattern runs about
 * thirteen minutes before repeating. That is why the tick counter is monotonic
 * rather than an index modulo a frame array: the whole point is the long cycle,
 * and a fixed array of frames would throw it away.
 *
 * Degrades to a scanning ASCII meter when the glyph mode is ascii.
 */
export function ActivityIndicator({
  color,
  intervalMs = MOTION.indicator,
  animate = true,
}: {
  color: string;
  intervalMs?: number;
  animate?: boolean;
}): React.ReactElement {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => {
      setTick((value) => value + 1);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, animate]);

  // Resolved per render so a runtime glyph-mode change takes effect.
  return <Text color={color}>{laneFrame(tick, getGlyphs())}</Text>;
}
