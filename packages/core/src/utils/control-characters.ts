/** C0 controls, DEL and C1 controls: everything that can start or end a terminal escape sequence. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_RUNS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Text with each run of control characters replaced, so it cannot carry an escape sequence that
 * moves the cursor, recolors output or rewrites what the terminal shows.
 */
export function replaceControlCharacters(text: string, replacement: string): string {
  return text.replace(CONTROL_CHARACTER_RUNS, replacement);
}
