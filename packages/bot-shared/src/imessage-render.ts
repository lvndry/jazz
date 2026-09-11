/**
 * @fileoverview Rendering for Apple Messages, whichever transport delivers it.
 *
 * The dialect belongs to the client, not the pipe: the local `imsg` bridge and
 * a hosted line both end up in the same bubble, with the same lack of markup
 * and the same lack of buttons. Kept here so both render identically.
 */

import { type OutgoingMessage, renderChoicesAsText, type SurfaceCapabilities } from "./surface";

/**
 * Where one outgoing message is cut.
 *
 * iMessage publishes no hard per-message limit and will carry far more than
 * this, so it is a readability bound rather than a protocol one: past roughly
 * this much text the Messages bubble becomes a wall on a phone screen, and a
 * long agent answer reads better as a few bubbles than as one enormous one.
 */
export const IMESSAGE_CHUNK_CHARS = 2_000;

export const IMESSAGE_CAPABILITIES: SurfaceCapabilities = {
  // Editing a sent message exists in Messages but only through `imsg`'s bridge
  // tier, which requires SIP to be disabled. Not worth that, so: append-only.
  editMessages: false,
  buttons: false,
  attachments: true,
  // Messages has no button of any kind; a URL is just text in a bubble.
  linkButtons: false,
  // Typing indicators are also bridge-tier for the same reason.
  typingIndicator: false,
  maxMessageChars: IMESSAGE_CHUNK_CHARS,
};

/**
 * Flatten to plain text, keeping code spans legible as quotations.
 *
 * Deliberately not `renderPlain`: that drops every mark, and an unmarked tool
 * name or command run together with the surrounding sentence is the one loss
 * that actually costs the reader something.
 */
export function renderForIMessage(message: OutgoingMessage): string {
  const rendered = message.body
    .map((block) => {
      switch (block.kind) {
        case "line":
        case "subtle":
          // iMessage has no way to make a line recede, so a cost trailer reads
          // as an ordinary line. Better that than inventing a marker for it.
          return block.spans
            .map((span) => (span.kind === "code" ? `“${span.text}”` : span.text))
            .join("");
        case "codeBlock":
          return block.text;
        case "quote":
          return block.text
            .split("\n")
            .map((row) => `> ${row}`)
            .join("\n");
      }
    })
    .join("\n");

  // Suggestions are an affordance nobody is waiting on. Numbering them here
  // would append a menu to every single answer that the person has to read past.
  if (
    message.choices === undefined ||
    message.choices.length === 0 ||
    (message.choiceKind ?? "prompt") === "suggestion"
  ) {
    return rendered;
  }
  return `${rendered}\n\n${renderChoicesAsText(message.choices)}\n\n(reply with a number)`;
}
