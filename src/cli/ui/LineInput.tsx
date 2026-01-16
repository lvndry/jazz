import { Text, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function deletePreviousWordAtCursor(value: string, cursor: number): { next: string; cursor: number } {
  if (value.length === 0 || cursor === 0) return { next: value, cursor };

  let i = cursor;

  // 1) Remove trailing spaces before the cursor.
  while (i > 0 && value[i - 1] === " ") i -= 1;
  // 2) Remove the word.
  while (i > 0 && value[i - 1] !== " ") i -= 1;

  return { next: value.slice(0, i) + value.slice(cursor), cursor: i };
}

export function LineInput({
  value,
  onChange,
  onSubmit,
  mask,
  resetKey,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (val: string) => void;
  mask?: string;
  resetKey?: string | number;
}): React.ReactElement {
  const [cursor, setCursor] = useState<number>(value.length);
  const lastValueRef = useRef<string>(value);

  // Keep cursor in bounds when parent updates value (but don't force it to end).
  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      setCursor((c) => clamp(c, 0, value.length));
    }
  }, [value]);

  // When prompt changes, put cursor at end (native-feeling).
  useEffect(() => {
    if (resetKey !== undefined) {
      setCursor(value.length);
    }
  }, [resetKey, value.length]);

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => clamp(c - 1, 0, value.length));
      return;
    }

    if (key.rightArrow) {
      setCursor((c) => clamp(c + 1, 0, value.length));
      return;
    }

    // Readline-ish cursor movement.
    if (key.ctrl && input === "a") {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === "e") {
      setCursor(value.length);
      return;
    }

    // Terminal reality check:
    // - Cmd is usually not transmitted to terminal apps, so we can't reliably detect it.
    // - Option (Alt) comes through as `meta` in Ink. We support meta+backspace to delete word.
    if ((key.meta && key.backspace) || (key.ctrl && input === "w")) {
      const { next, cursor: nextCursor } = deletePreviousWordAtCursor(value, cursor);
      onChange(next);
      setCursor(nextCursor);
      return;
    }

    // Ctrl+U clears the whole line (common readline behavior).
    if (key.ctrl && input === "u") {
      onChange("");
      setCursor(0);
      return;
    }

    if (key.backspace) {
      if (cursor === 0) return;
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      onChange(next);
      setCursor((c) => clamp(c - 1, 0, next.length));
      return;
    }

    if (key.delete) {
      if (cursor >= value.length) return;
      const next = value.slice(0, cursor) + value.slice(cursor + 1);
      onChange(next);
      return;
    }

    // Ignore other control keys.
    if (key.ctrl || key.meta) return;

    if (input.length > 0) {
      const next = value.slice(0, cursor) + input + value.slice(cursor);
      onChange(next);
      setCursor((c) => clamp(c + input.length, 0, next.length));
    }
  });

  const rendered = useMemo((): { before: string; at: string; after: string } => {
    const displayed = mask ? mask.repeat(value.length) : value;
    const c = clamp(cursor, 0, displayed.length);
    const before = displayed.slice(0, c);
    const at = c < displayed.length ? displayed.charAt(c) : " ";
    const after = c < displayed.length ? displayed.slice(c + 1) : "";
    return { before, at, after };
  }, [mask, value]);

  // Render a visible cursor at the current position.
  return (
    <Text>
      {rendered.before}
      <Text inverse>{rendered.at}</Text>
      {rendered.after}
    </Text>
  );
}

