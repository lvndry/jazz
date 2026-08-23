/**
 * Mints a conversation id.
 *
 * Random rather than a timestamp because a conversation id names shared state — the
 * conversation log, the todo file, the log group — and two runs starting in the same
 * millisecond would silently share all three. Two `jazz run` invocations from one webhook
 * bridge is enough to hit that.
 *
 * The optional prefix is for legibility only: it says what created the conversation when
 * you are looking at a directory of them. Uniqueness comes entirely from the random part.
 */

import short from "short-uuid";

export function generateConversationId(prefix?: string): string {
  const unique = short.generate();
  return prefix === undefined ? unique : `${prefix}-${unique}`;
}
