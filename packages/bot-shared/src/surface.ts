/**
 * @fileoverview What a chat surface has to provide for the shared bridge core.
 *
 * The core drives a Jazz run and narrates it — progress, approvals, questions,
 * the answer. Every one of those needs text on screen, and the four surfaces
 * disagree about what text is: Telegram wants HTML, Discord wants its own
 * markdown dialect, iMessage wants plain UTF-8, WhatsApp wants asterisks. They
 * also disagree about whether a message can be edited after it is sent, whether
 * a choice can be a button, and how long a message may be.
 *
 * So the core never writes markup. It builds `RichText` — a handful of blocks
 * with named roles — and the surface renders that dialect. A surface that
 * cannot do something (iMessage cannot edit a sent message) says so in its
 * capabilities, and the core picks a different shape rather than failing.
 */

/** An inline run of text inside a line, tagged with what it means. */
export type Span =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "code"; readonly text: string };

export const text = (value: string): Span => ({ kind: "text", text: value });
export const bold = (value: string): Span => ({ kind: "bold", text: value });
export const code = (value: string): Span => ({ kind: "code", text: value });

/**
 * A block of the message under construction.
 *
 * `quote` carries `expandable` because Telegram can collapse a long quote
 * behind a tap and the others cannot; a surface without that affordance renders
 * it as an ordinary quote, which is why this is a hint and not a demand.
 */
export type Block =
  | { readonly kind: "line"; readonly spans: readonly Span[] }
  | { readonly kind: "codeBlock"; readonly text: string; readonly language?: string }
  | { readonly kind: "quote"; readonly text: string; readonly expandable?: boolean };

export type RichText = readonly Block[];

export const line = (...spans: readonly Span[]): Block => ({ kind: "line", spans });
export const plainLine = (value: string): Block => line(text(value));
export const codeBlock = (value: string, language?: string): Block => ({
  kind: "codeBlock",
  text: value,
  ...(language === undefined ? {} : { language }),
});
export const quote = (value: string, expandable = false): Block => ({
  kind: "quote",
  text: value,
  expandable,
});

/**
 * A choice put to the human: an approval, a mode, a model, a follow-up.
 *
 * `id` is what comes back when it is picked and is the only part the core
 * routes on. Surfaces with buttons attach it to the button; surfaces without
 * them number the options and match the human's reply back to an id, so the id
 * must survive a round trip through a text message the person typed.
 */
export interface Choice {
  readonly id: string;
  readonly label: string;
  /** `danger` marks a destructive option so a surface can colour it; advisory. */
  readonly intent?: "default" | "primary" | "danger";
}

export interface OutgoingMessage {
  readonly body: RichText;
  /** Rendered as buttons where the surface has them, numbered text where it doesn't. */
  readonly choices?: readonly Choice[];
  readonly replyTo?: MessageRef;
}

/** A surface-native message identifier, opaque to the core. */
export type MessageRef = string;

/** A surface-native conversation identifier, opaque to the core. */
export type ChatId = string;

export interface SurfaceCapabilities {
  /**
   * Whether a sent message can be rewritten in place. The live progress bubble
   * is one edited message where this is true, and a single "working…" message
   * followed by the answer where it is false — iMessage and WhatsApp cannot
   * edit, and repeatedly sending progress would be a notification per tick.
   */
  readonly editMessages: boolean;
  /** Whether choices can be buttons. False falls back to numbered text replies. */
  readonly buttons: boolean;
  readonly attachments: boolean;
  readonly typingIndicator: boolean;
  /** Hard per-message character limit the splitter stays under. */
  readonly maxMessageChars: number;
}

export interface Surface {
  /** Stable short name, used in log lines and as the sandbox's surface tag. */
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;

  /** Render for this surface's dialect, split to `maxMessageChars`, send in order. */
  send(chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined>;

  /**
   * Rewrite an already-sent message. Only called when `editMessages` is true,
   * so a surface without editing does not have to implement it.
   */
  edit?(chatId: ChatId, ref: MessageRef, message: OutgoingMessage): Promise<void>;

  /** Only called when `attachments` is true. */
  sendFile?(chatId: ChatId, filePath: string, caption?: string): Promise<void>;

  /** Best-effort "the agent is working" hint; only called when `typingIndicator` is true. */
  typing?(chatId: ChatId): Promise<void>;
}

/**
 * Flatten to plain UTF-8, dropping every mark.
 *
 * The baseline renderer: what a surface with no formatting of its own uses, and
 * what a formatting surface falls back to when it rejects its own markup (which
 * Telegram does, on a malformed tag it produced itself from model prose).
 */
export function renderPlain(body: RichText): string {
  return body
    .map((block) => {
      switch (block.kind) {
        case "line":
          return block.spans.map((span) => span.text).join("");
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
}

/**
 * Append the choices as a numbered list the human can answer by typing.
 *
 * The fallback for surfaces without buttons. Numbers rather than the labels
 * themselves because a label can be long, can repeat, and can contain the same
 * words the person would naturally type in a normal message.
 */
export function renderChoicesAsText(choices: readonly Choice[]): string {
  return choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("\n");
}

/**
 * Match a typed reply back to a choice: its number, or its label verbatim.
 *
 * Returns undefined when the reply is not an answer to this prompt at all,
 * which is the common case — a person whose approval prompt is outstanding is
 * just as likely to send an unrelated message, and that has to fall through to
 * the agent rather than be swallowed as a mis-parsed decision.
 */
export function matchChoice(choices: readonly Choice[], reply: string): Choice | undefined {
  const trimmed = reply.trim();
  if (trimmed.length === 0) return undefined;

  const asNumber = Number.parseInt(trimmed, 10);
  if (String(asNumber) === trimmed && asNumber >= 1 && asNumber <= choices.length) {
    return choices[asNumber - 1];
  }

  const lowered = trimmed.toLowerCase();
  return choices.find((choice) => choice.label.toLowerCase() === lowered);
}

/**
 * Split rendered text into sendable chunks under `limit`.
 *
 * Prefers a paragraph break, then a line break, then a space, and only cuts
 * mid-word when a single word is longer than the limit. Surfaces whose markup
 * spans lines (Telegram HTML) split their own blocks before calling this.
 */
export function splitForSurface(rendered: string, limit: number): string[] {
  if (rendered.length <= limit) return [rendered];

  const chunks: string[] = [];
  let remaining = rendered;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const cut = ["\n\n", "\n", " "]
      .map((separator) => window.lastIndexOf(separator))
      .find((index) => index > limit * 0.5);
    const end = cut ?? limit;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
