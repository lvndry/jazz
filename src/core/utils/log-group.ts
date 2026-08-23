/**
 * Names the log file a conversation's output is written to.
 *
 * Derived, never stored and never passed around: a run already knows its agent and its
 * conversation, and an extra field carrying "which log" only invited the two to disagree.
 * They did — the interactive chat bound one per sitting, so starting a new conversation
 * kept writing to the previous one's file, and to the previous one's todo list with it.
 */

const UNSAFE = /[^A-Za-z0-9_-]/g;
const MAX_SEGMENT = 64;

function safe(value: string): string {
  const trimmed = value.trim().replace(UNSAFE, "-").slice(0, MAX_SEGMENT);
  return trimmed.length > 0 ? trimmed : "unknown";
}

/**
 * Groups a conversation's log output, however many runs and processes it spans.
 *
 * The separator is `__` rather than something more readable because the LoggerService
 * sanitizes its filename with `[^a-zA-Z0-9_-] -> "_"`. A `~` here would survive one writer
 * and be rewritten by the other, putting one conversation's lines in two files.
 */
export function conversationLogGroup(agentId: string, conversationId: string): string {
  return `${safe(agentId)}__${safe(conversationId)}`;
}
