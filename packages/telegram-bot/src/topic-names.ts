/**
 * @fileoverview Naming a topic from the message that opened it.
 *
 * A topic a person opens by simply writing arrives with a placeholder name and
 * `is_name_implicit` set, which is Telegram asking the bot to name it. The name is cut from
 * the person's own first message: it costs no model call, and it is what they would
 * recognise in the topic list.
 */

/** Telegram's own limit on a topic name. */
export const TOPIC_NAME_LIMIT = 128;

/**
 * The topic list shows about this many characters on a phone before it cuts the name itself,
 * so a longer one only moves the cut somewhere worse.
 */
const TOPIC_NAME_TARGET_CHARS = 48;

/** A cut this early in the name leaves too little to recognise, so the word is cut instead. */
const SHORTEST_WORD_CUT = TOPIC_NAME_TARGET_CHARS / 2;

/**
 * A topic name cut from `messageText`, or undefined when the message has no words to cut one
 * from. Ends on a whole word where one ends late enough to leave a recognisable name.
 */
export function topicNameFrom(messageText: string): string | undefined {
  const words = messageText.replace(/\s+/g, " ").trim();
  if (words.length === 0) {
    return undefined;
  }
  if (words.length <= TOPIC_NAME_TARGET_CHARS) {
    return words;
  }
  const head = words.slice(0, TOPIC_NAME_TARGET_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace >= SHORTEST_WORD_CUT ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}
