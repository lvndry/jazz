/**
 * @fileoverview The Telegram side of the `Surface` contract.
 *
 * Telegram is the richest of the four surfaces and the one the shared core was
 * shaped against: it edits sent messages, so progress is a live bubble; it has
 * inline keyboards, so a choice is a button; and it speaks an HTML flavour with
 * one affordance nothing else has — a quote that collapses behind a tap.
 *
 * The awkward part is routing a tap back. Telegram gives a button 64 bytes of
 * `callback_data` and nothing else, and the ids the agent mints for its prompts
 * are long enough that a naive `"<promptId>:<choiceId>"` can overflow it — after
 * which Telegram rejects the whole keyboard and the person is left with a
 * question they cannot answer. So buttons carry a short token
 * (`bot-shared/choice-tokens.ts`) and the pair it stands for is kept in memory.
 */

import { type ChoiceRef, createChoiceTokens } from "@jazz/bot-shared/choice-tokens";
import {
  type ChatId,
  type Choice,
  type MessageRef,
  type OutgoingFile,
  type OutgoingMessage,
  renderPlain,
  type RichText,
  type Surface,
  type SurfaceCapabilities,
} from "@jazz/bot-shared/surface";
import { dispatchTelegramRequest, isRenderingRejection } from "./telegram-dispatch";
import {
  escapeHtml,
  expandableBlockquote,
  markdownToTelegramHtml,
  splitForTelegram,
} from "./telegram-html";

/** Telegram's hosted Bot API; `TELEGRAM_API_BASE_URL` points a bridge at a self-hosted one. */
export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

/** Telegram's hard per-message limit is 4096; the splitter stays under it. */
const TELEGRAM_MAX_CHARS = 3_500;

const CAPABILITIES: SurfaceCapabilities = {
  editMessages: true,
  buttons: true,
  attachments: true,
  // Telegram calls these Web App buttons.
  linkButtons: true,
  typingIndicator: true,
  maxMessageChars: TELEGRAM_MAX_CHARS,
};

/**
 * How long a Bot API call may take. Without a bound a half-open connection stalls the call
 * for Bun's five-minute default, and with it the chat's whole send queue.
 */
const REQUEST_TIMEOUT_MS = 20_000;
/** An upload carries a file, so it gets longer. */
const UPLOAD_TIMEOUT_MS = 60_000;
/** A long poll holds the request open for its own `timeout` seconds; this is the margin. */
const LONG_POLL_MARGIN_MS = 15_000;

/** The deadline for one call: a long poll's own wait plus a margin, or the usual bound. */
export function requestTimeoutMs(method: string, payload: Record<string, unknown>): number {
  const pollSeconds = payload["timeout"];
  if (method === "getUpdates" && typeof pollSeconds === "number") {
    return pollSeconds * 1000 + LONG_POLL_MARGIN_MS;
  }
  return REQUEST_TIMEOUT_MS;
}

export interface TelegramSurfaceOptions {
  readonly botToken: string;
  /** The Bot API origin. Defaults to Telegram's own. */
  readonly apiBase?: string;
}

export function renderRichText(body: RichText): string {
  return body
    .map((block) => {
      switch (block.kind) {
        case "markdown":
          return markdownToTelegramHtml(block.text);
        case "subtle":
        case "line":
          // Telegram has no subtext style; these lines were already plain here,
          // and inventing italics for them would change what people see today.
          return block.spans
            .map((span) => {
              const escaped = escapeHtml(span.text);
              if (span.kind === "bold") return `<b>${escaped}</b>`;
              if (span.kind === "code") return `<code>${escaped}</code>`;
              return escaped;
            })
            .join("");
        case "codeBlock":
          return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
        case "quote":
          return block.expandable === true
            ? expandableBlockquote(block.text)
            : `<blockquote>${escapeHtml(block.text)}</blockquote>`;
      }
    })
    .join("\n");
}

/** One message's worth of a body, in HTML and as the plain words to fall back to. */
interface MessagePiece {
  readonly html: string;
  readonly plain: string;
}

/** Telegram rejects a message longer than this, whatever the splitter aimed for. */
const TELEGRAM_HARD_LIMIT = 4_096;

/**
 * Convert one Markdown chunk, halving it at a line break until its HTML fits. Dense markup
 * (every word bold) can grow a chunk past the hard limit after conversion.
 */
function pushMarkdown(pieces: MessagePiece[], chunk: string): void {
  const html = markdownToTelegramHtml(chunk);
  if (html.length <= TELEGRAM_HARD_LIMIT || chunk.length < 2) {
    pieces.push({ html, plain: chunk });
    return;
  }
  const middle = Math.floor(chunk.length / 2);
  const breakAt = chunk.lastIndexOf("\n", middle);
  const cut = breakAt > 0 ? breakAt : middle;
  pushMarkdown(pieces, chunk.slice(0, cut).trim());
  pushMarkdown(pieces, chunk.slice(cut).trim());
}

/**
 * Cut a body into messages under Telegram's limit without cutting inside markup.
 *
 * Model prose (a `markdown` block) is split as Markdown and each piece converted on its
 * own, so no HTML tag is ever cut in two. Everything else is short bridge text rendered
 * whole. Adjacent pieces are then packed back together while they fit.
 */
export function telegramPieces(body: RichText): MessagePiece[] {
  const pieces: MessagePiece[] = [];
  let pending: RichText[number][] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    const html = renderRichText(pending);
    const plain = renderPlain(pending);
    const htmlChunks = splitForTelegram(html);
    // Bridge-built text is short; the rare over-long one is split as before.
    if (htmlChunks.length === 1) {
      pieces.push({ html, plain });
    } else {
      for (const chunk of htmlChunks) pieces.push({ html: chunk, plain: chunk });
    }
    pending = [];
  };
  for (const block of body) {
    if (block.kind !== "markdown") {
      pending.push(block);
      continue;
    }
    flush();
    for (const chunk of splitForTelegram(block.text)) {
      pushMarkdown(pieces, chunk);
    }
  }
  flush();

  const packed: MessagePiece[] = [];
  for (const piece of pieces) {
    const last = packed.at(-1);
    if (last !== undefined && last.html.length + 1 + piece.html.length <= TELEGRAM_MAX_CHARS) {
      packed[packed.length - 1] = {
        html: `${last.html}\n${piece.html}`,
        plain: `${last.plain}\n${piece.plain}`,
      };
    } else {
      packed.push(piece);
    }
  }
  return packed;
}

export interface TelegramSurface extends Surface {
  setChoices(
    chatId: ChatId,
    ref: MessageRef,
    choices: readonly Choice[],
    promptId?: string,
  ): Promise<void>;
  /** Resolve a tapped button back to the prompt and option it stood for. */
  readChoice(callbackData: string): ChoiceRef | undefined;
  /** Post an arbitrary Bot API call, for the parts of the bridge that are not the core's. */
  call(method: string, payload: Record<string, unknown>, bestEffort?: boolean): Promise<unknown>;
}

export function createTelegramSurface(options: TelegramSurfaceOptions): TelegramSurface {
  const choiceTokens = createChoiceTokens();
  const apiBase = options.apiBase ?? DEFAULT_TELEGRAM_API_BASE;

  const call = (
    method: string,
    payload: Record<string, unknown>,
    bestEffort = false,
  ): Promise<unknown> =>
    dispatchTelegramRequest({
      method,
      chatId: typeof payload["chat_id"] === "number" ? payload["chat_id"] : undefined,
      bestEffort,
      send: () =>
        fetch(`${apiBase}/bot${options.botToken}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(requestTimeoutMs(method, payload)),
        }),
    });

  /**
   * Two buttons a row.
   *
   * One per row wastes vertical space on the two-option prompts that make up
   * almost all of these; more than two makes the labels unreadable at a phone's
   * width, which is where these are answered.
   */
  const keyboardFor = (
    choices: readonly Choice[],
    promptId: string | undefined,
  ): Record<string, unknown> => {
    const buttons = choices.map((choice) =>
      // A URL button opens a page instead of calling back, so it carries no
      // token — Telegram rejects a button that has both.
      choice.url === undefined
        ? {
            text: choice.label,
            callback_data: choiceTokens.mint({ promptId: promptId ?? "", choiceId: choice.id }),
          }
        : { text: choice.label, web_app: { url: choice.url } },
    );
    const rows: (typeof buttons)[] = [];
    for (let index = 0; index < buttons.length; index += 2) {
      rows.push(buttons.slice(index, index + 2));
    }
    return { inline_keyboard: rows };
  };

  const messageIdOf = (response: unknown): number | undefined => {
    const result = (response as { result?: { message_id?: number } } | undefined)?.result;
    return typeof result?.message_id === "number" ? result.message_id : undefined;
  };

  const payloadFor = (chatId: ChatId, message: OutgoingMessage) => {
    // An empty choice list is meaningful: it is what clears a keyboard from a
    // message that had one, so it must reach Telegram rather than be dropped as
    // "no choices".
    const markup =
      message.choices === undefined ? undefined : keyboardFor(message.choices, message.promptId);
    return {
      chat_id: Number.parseInt(chatId, 10),
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      ...(markup === undefined ? {} : { reply_markup: markup }),
      ...(message.replyTo === undefined
        ? {}
        : { reply_parameters: { message_id: Number.parseInt(message.replyTo, 10) } }),
    };
  };

  return {
    name: "telegram",
    capabilities: CAPABILITIES,
    call,

    readChoice: (callbackData: string): ChoiceRef | undefined => choiceTokens.read(callbackData),

    async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined> {
      const base = payloadFor(chatId, message);
      const pieces = telegramPieces(message.body);
      let lastMessageId: number | undefined;

      for (const [index, piece] of pieces.entries()) {
        // The keyboard belongs on the last chunk only: a person scrolling a
        // split answer should find the buttons at the end of it, not halfway.
        const isLast = index === pieces.length - 1;
        const payload = {
          ...base,
          text: piece.html,
          ...(isLast ? {} : { reply_markup: undefined }),
        };
        const sent = await call("sendMessage", payload);

        if (isRenderingRejection(sent)) {
          // Telegram rejected markup this bridge produced from model prose.
          // Falling back to the same words without tags is better than dropping
          // an answer the agent already paid to compute.
          const plain = await call("sendMessage", {
            ...payload,
            text: piece.plain,
            parse_mode: undefined,
          });
          lastMessageId = messageIdOf(plain) ?? lastMessageId;
          continue;
        }
        lastMessageId = messageIdOf(sent) ?? lastMessageId;
      }
      return lastMessageId === undefined ? undefined : String(lastMessageId);
    },

    async setChoices(
      chatId: ChatId,
      ref: MessageRef,
      choices: readonly Choice[],
      promptId?: string,
    ): Promise<void> {
      await call(
        "editMessageReplyMarkup",
        {
          chat_id: Number.parseInt(chatId, 10),
          message_id: Number.parseInt(ref, 10),
          reply_markup: keyboardFor(choices, promptId),
        },
        true,
      );
    },

    async edit(chatId: ChatId, ref: MessageRef, message: OutgoingMessage): Promise<void> {
      await call(
        "editMessageText",
        {
          ...payloadFor(chatId, message),
          message_id: Number.parseInt(ref, 10),
          text: renderRichText(message.body),
        },
        // Edits race the next tick and Telegram rejects a no-op edit outright;
        // neither is worth surfacing as an error.
        true,
      );
    },

    async sendFile(chatId: ChatId, file: OutgoingFile, caption?: string): Promise<void> {
      const form = new FormData();
      form.append("chat_id", String(Number.parseInt(chatId, 10)));
      // The bytes the core read from where it confined the file; the path is never reopened.
      form.append("photo", new Blob([file.bytes], { type: "image/png" }), file.filename);
      if (caption !== undefined) form.append("caption", caption);

      await dispatchTelegramRequest({
        method: "sendPhoto",
        chatId: Number.parseInt(chatId, 10),
        send: () =>
          fetch(`${apiBase}/bot${options.botToken}/sendPhoto`, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          }),
      });
    },

    async deleteReceived(chatId: ChatId, ref: MessageRef): Promise<void> {
      await call("deleteMessage", {
        chat_id: Number.parseInt(chatId, 10),
        message_id: Number.parseInt(ref, 10),
      });
    },

    async typing(chatId: ChatId): Promise<void> {
      await call(
        "sendChatAction",
        { chat_id: Number.parseInt(chatId, 10), action: "typing" },
        true,
      );
    },
  };
}
