import { Text } from "ink";
import React, { useEffect, useState } from "react";
import { getGlyphs } from "../glyphs";

const FRAMES = getGlyphs().meterFrames;

/**
 * Jazz's signature waiting animation: a small audio level meter pulsing
 * like a live signal. Replaces the generic animated-dots ellipsis in every
 * activity state. Degrades to a scanning ASCII meter when the glyph mode
 * is ascii.
 */
export function Equalizer({
  color,
  intervalMs = 120,
}: {
  color: string;
  intervalMs?: number;
}): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((value) => (value + 1) % FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return <Text color={color}>{FRAMES[frameIndex]}</Text>;
}
