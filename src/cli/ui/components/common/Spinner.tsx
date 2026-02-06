import { Text } from "ink";
import InkSpinner from "ink-spinner";
import React from "react";

export interface SpinnerProps {
  /** Spinner type */
  type?: "dots" | "line" | "pipe" | "simpleDots" | "simpleDotsScrolling";
  /** Optional label text */
  label?: string;
  /** Color for the spinner */
  color?: string;
}

/**
 * Spinner component for loading states.
 */
export const Spinner = React.memo(function Spinner({
  type = "dots",
  label,
  color = "cyan",
}: SpinnerProps): React.ReactElement {
  return (
    <>
      <Text color={color}>
        <InkSpinner type={type} />
      </Text>
      {label && <Text color={color}> {label}</Text>}
    </>
  );
});
