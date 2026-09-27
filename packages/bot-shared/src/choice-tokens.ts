/**
 * @fileoverview Short tokens a button carries in place of the prompt and choice it answers.
 *
 * A platform gives a button a small payload and nothing else: Telegram allows 64 bytes of
 * `callback_data`, Discord 100 characters of `custom_id`. The ids the agent mints for its
 * prompts are long enough that a naive `"<promptId>:<choiceId>"` can overflow either, after
 * which the platform rejects the whole keyboard and the person is left with a question they
 * cannot answer. So buttons carry a short token and the pair it stands for is kept here.
 */

/**
 * How many choice tokens to remember.
 *
 * A token is only useful while its keyboard is on screen and its run is alive,
 * but an abandoned keyboard is never cleaned up by anyone, so the map is capped
 * and the oldest entries fall out. Generous enough that a tap on anything from
 * a recent conversation still resolves.
 */
const CHOICE_TOKEN_LIMIT = 1_000;

/** What a tapped button stands for. */
export interface ChoiceRef {
  readonly promptId: string;
  readonly choiceId: string;
}

/** The payload prefix these tokens own; other prefixes route elsewhere. */
export const CHOICE_CALLBACK_PREFIX = "ch";

/**
 * The short tokens buttons carry, and what each stands for.
 *
 * Separate from the surface so the encoding and its eviction can be tested
 * without a bot token or a network — this is the part that decides whether a
 * tap resolves the right prompt, and it is worth being sure of.
 */
export interface ChoiceTokens {
  mint(ref: ChoiceRef): string;
  read(payload: string): ChoiceRef | undefined;
  readonly size: number;
}

export function createChoiceTokens(limit: number = CHOICE_TOKEN_LIMIT): ChoiceTokens {
  const refs = new Map<string, ChoiceRef>();
  let next = 0;

  return {
    mint(ref: ChoiceRef): string {
      const token = (next++).toString(36);
      refs.set(token, ref);
      // Insertion-ordered, so the first key is the oldest.
      if (refs.size > limit) {
        const oldest = refs.keys().next();
        if (!oldest.done) refs.delete(oldest.value);
      }
      return `${CHOICE_CALLBACK_PREFIX}:${token}`;
    },
    read(payload: string): ChoiceRef | undefined {
      const [prefix, token] = payload.split(":");
      if (prefix !== CHOICE_CALLBACK_PREFIX || token === undefined) return undefined;
      return refs.get(token);
    },
    get size() {
      return refs.size;
    },
  };
}
