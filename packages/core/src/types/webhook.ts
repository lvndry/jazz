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
 * Longest thread key accepted.
 *
 * `storageSafeSegment` would make any length safe as a path segment, so this is not a
 * security boundary — it is a sanity bound, so a caller sending a whole document as a
 * thread key gets told instead of silently opening a conversation nobody can find again.
 */
export const MAX_WEBHOOK_THREAD_KEY_LENGTH = 200;
