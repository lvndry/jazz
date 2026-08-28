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
}
