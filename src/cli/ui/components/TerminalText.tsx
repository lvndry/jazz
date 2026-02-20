import type { TextProps } from "ink";
import React from "react";
import { PreWrappedText } from "./PreWrappedText";

/**
 * TerminalText — the single primitive for rendering pre-formatted terminal text.
 *
 * Use for any text that is already wrapped (via wrapToWidth) and optionally
 * padded (via padLines). Uses wrap="truncate" to prevent Ink/Yoga from
 * re-wrapping, which would cause layout bugs during live re-renders.
 *
 * For formatting pipeline, use formatForTerminal() from markdown-formatter
 * before passing content to this component.
 */
export function TerminalText({ children, ...props }: Omit<TextProps, "wrap">): React.ReactElement {
  return <PreWrappedText {...props}>{children}</PreWrappedText>;
}
