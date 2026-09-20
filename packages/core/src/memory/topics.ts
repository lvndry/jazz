/**
 * Deciding which topics a request is about.
 *
 * The store answers "what is in force right now" by reading two places: the
 * `always` directory, and the `when/<topic>` directory of each active topic.
 * Nothing walks the whole store, so what recall costs tracks how much is
 * relevant rather than how much has ever been remembered.
 *
 * Matching is deterministic and lexical. There are no embeddings, and no model
 * call decides what to recall: a recall step that needed a model would cost a
 * round trip on every turn and could fail in ways the turn cannot recover from.
 */
import { slugifyMemorySegment } from "./entry-path";
import { matchesWholeWord } from "../utils/string";

/**
 * Shortest topic that may be matched.
 *
 * Topics are coined by whichever turn first stored something under them, so
 * they can be as short as the model felt like being. Below this length a topic
 * is likelier to appear inside an unrelated word than to be meant — an "art"
 * topic would otherwise fire on "start", "part" and "smart".
 */
export const MIN_MATCHABLE_TOPIC_LENGTH = 4;

export type TopicMatchReason = "named" | "spelled-differently" | "not-mentioned" | "too-short";

export interface TopicMatch {
  readonly topic: string;
  readonly matched: boolean;
  /** Why it did or did not match, for the log when recall surprises someone. */
  readonly reason: TopicMatchReason;
}

/**
 * Decides which of the store's topics this request is about.
 *
 * Matching is on the request text alone, never the working directory: a topic
 * describes a kind of work, so it has to be recognised wherever that work
 * happens rather than only where it was first stored.
 *
 * Every topic is reported with the reason it did or did not match. A topic
 * failing to fire is the one way this disappoints silently — the entry exists,
 * the user expects it to apply, and nothing says why it did not — so the
 * decision is made legible rather than merely made.
 */
export function matchTopics(requestText: string, topics: readonly string[]): readonly TopicMatch[] {
  const text = requestText.toLowerCase();
  const spacedCollapsedText = text.replace(/[^a-z0-9]+/g, "");

  return [...topics].sort().map((topic) => {
    if (topic.length < MIN_MATCHABLE_TOPIC_LENGTH) {
      return { topic, matched: false, reason: "too-short" as const };
    }

    if (matchesWholeWord(text, topic)) {
      return { topic, matched: true, reason: "named" as const };
    }

    // A topic stored as "mood-board" should still fire on "moodboard": the
    // spelling was chosen by an earlier turn and the user has no reason to
    // reproduce it. Both sides have their separators removed before comparing,
    // and the comparison is containment against a request that has also been
    // collapsed, so this only ever adds spelling tolerance.
    const collapsedTopic = slugifyMemorySegment(topic).replace(/-/g, "");
    const spelledDifferently =
      collapsedTopic.length >= MIN_MATCHABLE_TOPIC_LENGTH &&
      spacedCollapsedText.includes(collapsedTopic);

    return spelledDifferently
      ? { topic, matched: true, reason: "spelled-differently" as const }
      : { topic, matched: false, reason: "not-mentioned" as const };
  });
}

export function activeTopics(matches: readonly TopicMatch[]): readonly string[] {
  return matches.filter((match) => match.matched).map((match) => match.topic);
}
