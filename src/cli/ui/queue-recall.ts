export interface RecalledBuffer {
  readonly value: string;
  readonly cursor: number;
}

export function isCursorOnFirstLine(value: string, cursor: number): boolean {
  const firstNewline = value.indexOf("\n");
  return firstNewline === -1 || cursor <= firstNewline;
}

export function composeRecalledBuffer(queueText: string, draft: string): RecalledBuffer {
  const value = draft.length > 0 ? `${queueText}\n${draft}` : queueText;
  return { value, cursor: value.length };
}
