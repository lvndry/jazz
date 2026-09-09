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
 * question they cannot answer. So buttons carry a short token and the pair it
 * stands for is kept here.
 */

import {
  type ChatId,
  type Choice,
  type MessageRef,
  type OutgoingMessage,
  renderPlain,
  type RichText,
  type Surface,
  type SurfaceCapabilities,
} from "@jazz/bot-shared/surface";
import { dispatchTelegramRequest, isRenderingRejection } from "./telegram-dispatch";
import { escapeHtml, expandableBlockquote, splitForTelegram } from "./telegram-html";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Telegram's hard per-message limit is 4096; the splitter stays under it. */
const TELEGRAM_MAX_CHARS = 3_500;

/**
 * How many choice tokens to remember.
 *
 * A token is only useful while its keyboard is on screen and its run is alive,
 * but an abandoned keyboard is never cleaned up by anyone, so the map is capped
 * and the oldest entries fall out. Generous enough that a tap on anything from
 * a recent conversation still resolves.
 */
const CHOICE_TOKEN_LIMIT = 1_000;

const CAPABILITIES: SurfaceCapabilities = {
  editMessages: true,
  buttons: true,
  attachments: true,
  // Telegram calls these Web App buttons.
  linkButtons: true,
  typingIndicator: true,
  maxMessageChars: TELEGRAM_MAX_CHARS,
};

/** What a tapped button stands for. */
export interface ChoiceRef {
  readonly promptId: string;
  readonly choiceId: string;
}

/** The `callback_data` prefix this surface owns; other prefixes route elsewhere. */
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
  read(callbackData: string): ChoiceRef | undefined;
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
    read(callbackData: string): ChoiceRef | undefined {
      const [prefix, token] = callbackData.split(":");
      if (prefix !== CHOICE_CALLBACK_PREFIX || token === undefined) return undefined;
      return refs.get(token);
    },
    get size() {
      return refs.size;
    },
  };
}

export interface TelegramSurfaceOptions {
  readonly botToken: string;
}

export function renderRichText(body: RichText): string {
  return body
    .map((block) => {
      switch (block.kind) {
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

export interface TelegramSurface extends Surface {
  /** Resolve a tapped button back to the prompt and option it stood for. */
  readChoice(callbackData: string): ChoiceRef | undefined;
  /** Post an arbitrary Bot API call, for the parts of the bridge that are not the core's. */
  call(method: string, payload: Record<string, unknown>, bestEffort?: boolean): Promise<unknown>;
}

export function createTelegramSurface(options: TelegramSurfaceOptions): TelegramSurface {
  const choiceTokens = createChoiceTokens();

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
        fetch(`${TELEGRAM_API_BASE}/bot${options.botToken}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
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
      const chunks = splitForTelegram(renderRichText(message.body));
      let lastMessageId: number | undefined;

      for (const [index, chunk] of chunks.entries()) {
        // The keyboard belongs on the last chunk only: a person scrolling a
        // split answer should find the buttons at the end of it, not halfway.
        const isLast = index === chunks.length - 1;
        const payload = { ...base, text: chunk, ...(isLast ? {} : { reply_markup: undefined }) };
        const sent = await call("sendMessage", payload);

        if (isRenderingRejection(sent)) {
          // Telegram rejected markup this bridge produced from model prose.
          // Falling back to the same words without tags is better than dropping
          // an answer the agent already paid to compute.
          const plain = await call("sendMessage", {
            ...payload,
            text: renderPlain(message.body),
            parse_mode: undefined,
          });
          lastMessageId = messageIdOf(plain) ?? lastMessageId;
          continue;
        }
        lastMessageId = messageIdOf(sent) ?? lastMessageId;
      }
      return lastMessageId === undefined ? undefined : String(lastMessageId);
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

    async sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void> {
      const form = new FormData();
      form.append("chat_id", String(Number.parseInt(chatId, 10)));
      form.append("photo", Bun.file(filePath), filePath.split("/").at(-1) ?? "image.png");
      if (caption !== undefined) form.append("caption", caption);

      await dispatchTelegramRequest({
        method: "sendPhoto",
        chatId: Number.parseInt(chatId, 10),
        send: () =>
          fetch(`${TELEGRAM_API_BASE}/bot${options.botToken}/sendPhoto`, {
            method: "POST",
            body: form,
          }),
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
