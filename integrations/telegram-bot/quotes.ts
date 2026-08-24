/**
 * Reply context for incoming Telegram messages.
 *
 * Telegram sends the replied-to message as `reply_to_message`, but the agent only ever sees the
 * prompt text. Without a line naming what was quoted, "what about this one?" as a reply is
 * meaningless — and it silently *seems* to work whenever the quoted message happens to still be
 * in the chat's conversation history, which hides the failure until it isn't.
 */

/** The subset of a Telegram message this module needs to describe a quote. */
export interface QuotedMessage {
  readonly text?: string;
  readonly caption?: string;
  readonly from?: {
    readonly first_name?: string;
    readonly username?: string;
    readonly is_bot?: boolean;
  };
  readonly voice?: unknown;
  readonly audio?: unknown;
  readonly photo?: readonly unknown[];
  readonly document?: { readonly file_name?: string };
  readonly location?: unknown;
  readonly sticker?: { readonly emoji?: string };
}

export interface ReplyingMessage {
  readonly reply_to_message?: QuotedMessage;
  /** Set when the user highlighted only part of the quoted message before replying. */
  readonly quote?: { readonly text?: string };
}

/**
 * Quoted text is inlined into every prompt of the reply, so an accidental reply to a wall of text
 * would otherwise crowd out the conversation. Long enough to carry a paragraph of context.
 */
const QUOTED_TEXT_MAX_CHARS = 500;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string): string {
  return text.length > QUOTED_TEXT_MAX_CHARS
    ? `${text.slice(0, QUOTED_TEXT_MAX_CHARS).trimEnd()}…`
    : text;
}

function senderLabel(quoted: QuotedMessage): string {
  if (quoted.from?.is_bot === true) return "your earlier message";
  const name = quoted.from?.first_name?.trim() ?? quoted.from?.username?.trim();
  return name !== undefined && name.length > 0 ? `${name}'s message` : "an earlier message";
}

/** What the quoted message *is*, when it carries no text of its own. */
function mediaLabel(quoted: QuotedMessage): string | undefined {
  if (quoted.voice !== undefined) return "a voice message";
  if (quoted.audio !== undefined) return "an audio file";
  if (quoted.photo !== undefined && quoted.photo.length > 0) return "a photo";
  if (quoted.document !== undefined) {
    const fileName = quoted.document.file_name?.trim();
    return fileName !== undefined && fileName.length > 0 ? `the file ${fileName}` : "a file";
  }
  if (quoted.location !== undefined) return "a location";
  if (quoted.sticker !== undefined) return "a sticker";
  return undefined;
}

/**
 * One bracketed line describing what the user replied to, or undefined when the message is not a
 * reply (or quotes something with nothing describable in it).
 */
export function buildReplyContext(message: ReplyingMessage): string | undefined {
  const quoted = message.reply_to_message;
  if (quoted === undefined) return undefined;

  const highlight = collapse(message.quote?.text ?? "");
  const isPartial = highlight.length > 0;
  const body = isPartial ? highlight : collapse(quoted.text ?? quoted.caption ?? "");
  const media = mediaLabel(quoted);
  const sender = senderLabel(quoted);

  if (body.length === 0) {
    return media === undefined ? undefined : `[Replying to ${sender}: ${media}]`;
  }

  const quotedBody = `"${truncate(body)}"`;
  const subject =
    media !== undefined && !isPartial ? `${media} captioned ${quotedBody}` : quotedBody;
  return `[Replying to ${sender}${isPartial ? ", quoting" : ""}: ${subject}]`;
}

/** Prefix a prompt with its reply context, if the message is a reply. */
export function withReplyContext(message: ReplyingMessage, prompt: string): string {
  const context = buildReplyContext(message);
  return context === undefined ? prompt : `${context}\n\n${prompt}`;
}
