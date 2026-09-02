/**
 * @fileoverview A webhook door onto a specific agent.
 *
 * Where a peer is another agent asking a question, a webhook is any HTTP-capable external
 * system (GitHub, an email relay, IFTTT) waking a specific local agent to run a fixed
 * prompt. The payload is data the prompt is built from, never an instruction the agent
 * treats as coming from its owner — the same discipline peer replies and `web_fetch` output
 * already get.
 *
 * Called `webhook` rather than `trigger` because "trigger" already names an unrelated
 * feature — a wake trigger is an alarm clock the agent sets for itself, this is a door
 * somebody else knocks on. Two things sharing one word in a codebase is how it becomes
 * unreadable. `triggers` in config and `/triggers/<name>` in the URL still work; see
 * `migrateTriggersToWebhooks` and the daemon's route table.
 */

export interface WebhookConfig {
  /** Local name, used in the URL (`POST /webhooks/<name>`) and to look up its token. Unique. */
  readonly name: string;
  /** Which agent this webhook wakes. */
  readonly agentId: string;
  /**
   * The prompt run when this trigger fires. `{{payload}}` is replaced with the raw request
   * body, quoted — the payload is never merged into the prompt as an instruction.
   */
  readonly promptTemplate: string;
  /** Optional note for the operator; not sent to the model. */
  readonly description?: string;
  /**
   * Whether fires of this webhook share a conversation.
   *
   * `ephemeral` (the default, and what every webhook did before this existed) starts each
   * fire from nothing: a fresh conversation id, no history loaded. Right for a webhook that
   * reports an isolated event — a deploy finished, a form was submitted — where remembering
   * the last one buys nothing.
   *
   * `threaded` resumes instead. Fires carrying the same `X-Jazz-Thread` value continue one
   * conversation, so the agent remembers what was already said. Right for a webhook that
   * relays an ongoing exchange, where an amnesiac agent has to be re-told its own history on
   * every turn.
   */
  readonly conversation?: WebhookConversationMode;
}

export type WebhookConversationMode = "ephemeral" | "threaded";

/** Request header naming which thread a `threaded` webhook's fire belongs to. */
export const WEBHOOK_THREAD_HEADER = "x-jazz-thread";

/**
 * Request header giving a URL to report progress to while the run is going.
 *
 * A webhook is one held-open request that answers when the run finishes, so a caller learns
 * nothing in between — and a turn that reads a calendar and searches the web is minutes of
 * unexplained silence. A caller that has somewhere to listen can say so here.
 *
 * Loopback only, and not negotiable: this makes the daemon issue requests to an address
 * somebody else chose, which anywhere but the local machine is a way to make jazz knock on
 * doors on their behalf.
 */
export const WEBHOOK_PROGRESS_HEADER = "x-jazz-progress-url";

/**
 * Request header naming which progress events the caller wants.
 *
 * Comma-separated kinds. Absent means all of them: handing over a URL is already the act of
 * subscribing, and a caller that wants everything should not have to enumerate it. Naming
 * kinds narrows that, which is worth having because a tool-heavy run is chatty and most
 * callers care about one or two of these.
 *
 * An unknown kind is refused rather than ignored, for the same reason a non-loopback URL is:
 * a caller that misspelled one would otherwise wait forever for events that never come.
 */
export const WEBHOOK_PROGRESS_EVENTS_HEADER = "x-jazz-progress-events";

/** Every kind a caller may ask for. Must match `ToolProgressEvent["kind"]`. */
export const TOOL_PROGRESS_KINDS = ["tool-started", "tool-finished", "approval-required"] as const;

export type ToolProgressKind = (typeof TOOL_PROGRESS_KINDS)[number];

/**
 * Which events this caller asked for, or which name it got wrong.
 *
 * An empty or absent header is every kind, not none — see the header's own note.
 */
export function parseProgressEvents(
  raw: string | null,
): { readonly kinds: ReadonlySet<ToolProgressKind> } | { readonly unknownKind: string } {
  const named = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (named.length === 0) return { kinds: new Set(TOOL_PROGRESS_KINDS) };

  const kinds = new Set<ToolProgressKind>();
  for (const name of named) {
    const known = TOOL_PROGRESS_KINDS.find((kind) => kind === name);
    if (known === undefined) return { unknownKind: name };
    kinds.add(known);
  }
  return { kinds };
}

/** Whether a progress URL is one the daemon will agree to post to. */
export function isLoopbackProgressUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Longest thread key accepted.
 *
 * `storageSafeSegment` would make any length safe as a path segment, so this is not a
 * security boundary — it is a sanity bound, so a caller sending a whole document as a
 * thread key gets told instead of silently opening a conversation nobody can find again.
 */
export const MAX_WEBHOOK_THREAD_KEY_LENGTH = 200;
