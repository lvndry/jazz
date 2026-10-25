/**
 * A running call's arguments on one live row: the first line whole, the rest counted.
 * A multi-line command (a heredoc, a script) otherwise reads as its first line alone,
 * with nothing saying more is running.
 */

export interface FoldedOperation {
  readonly head: string;
  readonly hiddenLines: number;
}

export function foldOperation(text: string): FoldedOperation {
  const lines = text.trim().split("\n");
  return { head: (lines[0] ?? "").trimEnd(), hiddenLines: lines.length - 1 };
}

/** The hint beside a folded row, naming the key that prints the rest. */
export function foldHint(hiddenLines: number): string {
  return `ctrl+o for ${String(hiddenLines)} more line${hiddenLines === 1 ? "" : "s"}`;
}
