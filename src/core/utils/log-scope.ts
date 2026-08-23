/**
 * The key that scopes a run's log output to a file.
 *
 * Not an identity for anything. It names a log stream, which is why the interactive chat
 * can use a timestamped "this sitting" key while headless runs use one derived from the
 * conversation: nothing reads it back, nothing joins on it, and no two formats have to
 * agree. It was previously called a session id, which invited exactly that confusion —
 * `jazz run` invented a third format for years and nothing noticed.
 */

const UNSAFE = /[^A-Za-z0-9_-]/g;
const MAX_SEGMENT = 64;

function safe(value: string): string {
  const trimmed = value.trim().replace(UNSAFE, "-").slice(0, MAX_SEGMENT);
  return trimmed.length > 0 ? trimmed : "unknown";
}

/** Groups a conversation's log output, however many runs and processes it spans. */
export function conversationLogScope(agentId: string, conversationId: string): string {
  return `${safe(agentId)}~${safe(conversationId)}`;
}
