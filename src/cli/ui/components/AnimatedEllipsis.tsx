import { Text } from "ink";
import React, { useEffect, useState } from "react";

const FRAMES = ["", ".", "..", "..."] as const;

export function AnimatedEllipsis({
  label,
  color,
  intervalMs = 220,
}: {
  label: string;
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

  return <Text color={color}>{label + FRAMES[frameIndex]}</Text>;
}
