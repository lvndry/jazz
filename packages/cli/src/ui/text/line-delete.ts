/**
 * Where Cmd+Backspace (or Ctrl+U) stops deleting when the caret is at `caret`: the start of
 * the current line, or, when the caret already sits there, just before the preceding line
 * break, so the key joins the line onto the one above the way macOS text fields do. Works on
 * a string or an array of code points, so each renderer passes the units it indexes with.
 */
export function lineDeleteStart(text: string | readonly string[], caret: number): number {
  const at = Math.max(0, Math.min(caret, text.length));
  let index = at;
  while (index > 0 && text[index - 1] !== "\n") {
    index -= 1;
  }
  if (index === at && at > 0) {
    return at - 1;
  }
  return index;
}
