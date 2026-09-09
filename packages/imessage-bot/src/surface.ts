/**
 * @fileoverview The iMessage side of the `Surface` contract.
 *
 * iMessage has no rich text: no bold, no code spans, no buttons, and no way to
 * change a message once it has been sent. So this renderer flattens `RichText`
 * to plain UTF-8 and the capabilities say what is missing, which is what makes
 * the shared core fall back to an acknowledgement-then-answer shape instead of
 * a live-edited progress bubble, and to numbered replies instead of buttons.
 *
 * The one piece of formatting worth keeping is the code span. Losing the marks
 * around a tool name or a shell command makes a line like "run rm -rf build" —
 * which the agent means as a quotation — read as prose, so those are wrapped in
 * typographic quotes rather than dropped outright.
 */

import {
  type ChatId,
  type MessageRef,
  type OutgoingMessage,
  renderChoicesAsText,
  splitForSurface,
  type Surface,
  type SurfaceCapabilities,
} from "@jazz/bot-shared/surface";
import { type ImsgTarget, sendFile as imsgSendFile, sendText } from "./imsg";

/**
 * Where one outgoing message is cut.
 *
 * iMessage publishes no hard per-message limit and will carry far more than
 * this, so it is a readability bound rather than a protocol one: past roughly
 * this much text the Messages bubble becomes a wall on a phone screen, and a
 * long agent answer reads better as a few bubbles than as one enormous one.
 */
const IMESSAGE_CHUNK_CHARS = 2_000;

const CAPABILITIES: SurfaceCapabilities = {
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

export interface IMessageSurfaceOptions {
  readonly binary: string;
  /**
   * Resolve a conversation id back to something `imsg send` can address.
   *
   * The core only ever holds the opaque `ChatId` it was given, and iMessage
   * needs either a `chat.db` rowid or a handle — a group has no single handle,
   * so the mapping cannot be inferred from the id's text alone.
   */
  readonly resolveTarget: (chatId: ChatId) => ImsgTarget;
}

/**
 * How many recently sent messages to remember for the echo guard.
 *
 * Only has to cover the gap between sending and that same row coming back
 * through `imsg watch`, which is under a second; this is slack for a long
 * answer split into many chunks arriving behind a slow watcher.
 */
const SENT_ECHO_MEMORY = 50;

export interface IMessageSurface extends Surface {
  /**
   * Did this bridge send this exact text?
   *
   * Everything the bridge sends comes back through the watch stream marked as
   * from the account owner, which is the same mark a person typing on their own
   * Mac gets. Without this the bridge cannot tell its own reply from a message
   * to answer, and answering its own replies is an unbounded loop.
   */
  wasSentByUs(text: string): boolean;
}

export function createIMessageSurface(options: IMessageSurfaceOptions): IMessageSurface {
  const recentlySent: string[] = [];

  const remember = (chunk: string): void => {
    recentlySent.push(chunk.trim());
    if (recentlySent.length > SENT_ECHO_MEMORY) recentlySent.shift();
  };

  return {
    wasSentByUs: (text: string): boolean => recentlySent.includes(text.trim()),

    name: "imessage",
    capabilities: CAPABILITIES,

    async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined> {
      const target = options.resolveTarget(chatId);
      for (const chunk of splitForSurface(renderForIMessage(message), IMESSAGE_CHUNK_CHARS)) {
        if (chunk.trim().length === 0) continue;
        remember(chunk);
        await sendText(options.binary, target, chunk);
      }
      // Messages.app assigns the row id asynchronously and `imsg send` does not
      // hand one back, so there is nothing to return. Nothing in the core needs
      // it either: without editing, no ref is ever used to address a message
      // again — see `Surface.edit`, which this surface does not implement.
      return undefined;
    },

    sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void> {
      const target = options.resolveTarget(chatId);
      return imsgSendFile(options.binary, target, filePath).then(async () => {
        if (caption !== undefined && caption.trim().length > 0) {
          remember(caption);
          await sendText(options.binary, target, caption);
        }
      });
    },
  };
}
