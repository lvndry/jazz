/** A standing entry as the prompt shows it: the scope it came from and its first line. */
export interface ActivePreference {
  readonly scope: string;
  readonly summary: string;
}

/**
 * The line a standing entry occupies in the system prompt. Receipts match this
 * exact line to prove the entry reached a request, so both sides share it.
 */
export function formatPreferenceLine(preference: ActivePreference): string {
  return `- [${preference.scope}] ${preference.summary}`;
}
