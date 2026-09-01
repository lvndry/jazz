/**
 * @fileoverview A webhook door onto a specific agent.
 *
 * Where a peer is another agent asking a question, a trigger is any HTTP-capable external
 * system (a GitHub webhook, an email relay, IFTTT) waking a specific local agent to run a
 * fixed prompt. The payload is data the prompt is built from, never an instruction the agent
 * treats as coming from its owner — the same discipline peer replies and `web_fetch` output
 * already get.
 */

export interface TriggerConfig {
  /** Local name, used in the URL (`POST /triggers/<name>`) and to look up its token. Unique. */
  readonly name: string;
  /** Which agent this trigger wakes. */
  readonly agentId: string;
  /**
   * The prompt run when this trigger fires. `{{payload}}` is replaced with the raw request
   * body, quoted — the payload is never merged into the prompt as an instruction.
   */
  readonly promptTemplate: string;
  /** Optional note for `jazz triggers list`; not sent to the model. */
  readonly description?: string;
  /**
   * Whether fires of this trigger share a conversation.
   *
   * `ephemeral` (the default, and what every trigger did before this existed) starts each
   * fire from nothing: a fresh conversation id, no history loaded. Right for a webhook that
   * reports an isolated event — a deploy finished, a form was submitted — where remembering
   * the last one buys nothing.
   *
   * `threaded` resumes instead. Fires carrying the same `X-Jazz-Thread` value continue one
   * conversation, so the agent remembers what was already said. Right for a webhook that
   * relays an ongoing exchange, where an amnesiac agent has to be re-told its own history on
   * every turn.
   */
  readonly conversation?: TriggerConversationMode;
}

export type TriggerConversationMode = "ephemeral" | "threaded";

/** Request header naming which thread a `threaded` trigger's fire belongs to. */
export const TRIGGER_THREAD_HEADER = "x-jazz-thread";

/**
 * Longest thread key accepted.
 *
 * `storageSafeSegment` would make any length safe as a path segment, so this is not a
 * security boundary — it is a sanity bound, so a caller sending a whole document as a
 * thread key gets told instead of silently opening a conversation nobody can find again.
 */
export const MAX_TRIGGER_THREAD_KEY_LENGTH = 200;
