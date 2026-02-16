import { Text, type TextProps } from "ink";
import React from "react";

/**
 * PreWrappedText
 *
 * Use this when the string you render is *already hard-wrapped* to the terminal width
 * upstream (e.g. via `wrapToWidth(..., { hard: true })`).
 *
 * Why not `wrap="wrap"`?
 * Ink uses Yoga for layout, and during frequent live re-renders Yoga can
 * occasionally report an incorrect (too-small) available width for a subtree.
 * If we let Ink wrap again, that can degenerate into character-by-character
 * wrapping (1–2 chars per line) even though the text is already correctly wrapped.
 *
 * `wrap="truncate"` prevents Ink/Yoga from re-wrapping the text. In the normal case
 * it won’t actually truncate anything because the text lines already fit.
 */
export function PreWrappedText({
  children,
  ...props
}: Omit<TextProps, "wrap">): React.ReactElement {
  return (
    <Text
      {...props}
      wrap="truncate"
    >
      {children}
    </Text>
  );
}
