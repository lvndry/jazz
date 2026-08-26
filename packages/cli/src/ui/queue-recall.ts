/**
 * Cursor/buffer helpers for recalling a queued message back into the
 * composer (prepending it to the current draft) while typing.
 */

export interface RecalledBuffer {
  readonly value: string;
  readonly cursor: number;
}

export function isCursorOnFirstLine(value: string, cursor: number): boolean {
  const firstNewline = value.indexOf("\n");
  return firstNewline === -1 || cursor <= firstNewline;
}

export function isCursorOnLastLine(value: string, cursor: number): boolean {
  const lastNewline = value.lastIndexOf("\n");
  return lastNewline === -1 || cursor > lastNewline;
}

export function composeRecalledBuffer(queueText: string, draft: string): RecalledBuffer {
  const value = draft.length > 0 ? `${queueText}\n${draft}` : queueText;
  return { value, cursor: value.length };
}
