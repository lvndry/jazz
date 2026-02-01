import { Text } from "ink";
import React from "react";

interface SeparatorProps {
  /** Width of the separator (defaults to 40) */
  width?: number;
  /** Character to use for the separator */
  char?: string;
  /** Whether to dim the separator */
  dimColor?: boolean;
}

/**
 * Horizontal separator line.
 */
export const Separator = React.memo(function Separator({
  width = 40,
  char = "─",
  dimColor = true,
}: SeparatorProps): React.ReactElement {
  return <Text dimColor={dimColor}>{char.repeat(width)}</Text>;
});

export default Separator;
export type { SeparatorProps };
