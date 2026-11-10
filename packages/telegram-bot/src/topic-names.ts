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

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest run of whole characters from the start of `text` within `limit` UTF-16 units,
 * so an emoji (two units, or a whole joined sequence) is never cut in half.
 */
function headWithin(text: string, limit: number): string {
  let end = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    if (index + segment.length > limit) {
      break;
    }
    end = index + segment.length;
  }
  return text.slice(0, end);
}

/**
 * A topic name cut from `messageText`, or undefined when the message has no words to cut one
 * from. Counts what a person sees as characters, cuts only between them, ends on a whole word
 * where one ends late enough to leave a recognisable name, and stays within Telegram's limit.
 */
export function topicNameFrom(messageText: string): string | undefined {
  const words = messageText.replace(/\s+/g, " ").trim();
  if (words.length === 0) {
    return undefined;
  }
  const characters = [...graphemes.segment(words)].map((part) => part.segment);
  if (characters.length <= TOPIC_NAME_TARGET_CHARS && words.length <= TOPIC_NAME_LIMIT) {
    return words;
  }
  const head = characters.slice(0, TOPIC_NAME_TARGET_CHARS).join("");
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace >= SHORTEST_WORD_CUT ? head.slice(0, lastSpace) : head;
  const ellipsis = "…";
  return `${headWithin(cut.trimEnd(), TOPIC_NAME_LIMIT - ellipsis.length)}${ellipsis}`;
}
