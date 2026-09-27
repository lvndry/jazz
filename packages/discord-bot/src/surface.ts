/**
 * @fileoverview The Discord side of the `Surface` contract.
 *
 * Discord edits sent messages, so progress is a live message; it has buttons and select
 * menus, so a choice is a component; and it speaks Markdown with one mark of its own,
 * subtext (`-# `). Mentions are neutralised on the way out so a model that echoes
 * `@everyone` cannot ping a server.
 *
 * Components carry a short token (`bot-shared/choice-tokens.ts`) rather than the prompt
 * and choice they answer: `custom_id` holds 100 characters and an agent-minted prompt id
 * has no such bound. Up to five choices are buttons in one row; more become a select menu,
 * which is what a model or persona list needs.
 */

import {
  type ChoiceRef,
  type ChoiceTokens,
  createChoiceTokens,
} from "@jazz/bot-shared/choice-tokens";
import type {
  ChatId,
  Choice,
  MessageRef,
  OutgoingFile,
  OutgoingMessage,
  Surface,
  SurfaceCapabilities,
} from "@jazz/bot-shared/surface";
import {
  actionRow,
  BUTTON_DANGER,
  BUTTON_SECONDARY,
  BUTTON_SUCCESS,
  button,
  editMessage,
  patchMessage,
  sendAttachment,
  sendMessage,
  stringSelect,
  triggerTyping,
} from "./discord";
import { neutralizeBroadcastMentions, renderDiscordMarkdown, splitForDiscord } from "./discord-md";

/** Discord's per-message cap is 2000; the splitter stays under it. */
const DISCORD_MAX_CHARS = 1_900;

/** Buttons Discord fits in one action row; more choices become a select menu. */
const BUTTONS_PER_ROW = 5;

/** Discord's link-button style: opens `url` and sends no interaction. */
const BUTTON_LINK = 5;

const CAPABILITIES: SurfaceCapabilities = {
  editMessages: true,
  buttons: true,
  attachments: true,
  linkButtons: true,
  typingIndicator: true,
  maxMessageChars: DISCORD_MAX_CHARS,
};

export interface DiscordSurface extends Surface {
  setChoices(
    chatId: ChatId,
    ref: MessageRef,
    choices: readonly Choice[],
    promptId?: string,
  ): Promise<void>;
  /** Resolve a clicked component (its `custom_id`, or a select menu's value) to its choice. */
  readChoice(payload: string): ChoiceRef | undefined;
}

function styleFor(choice: Choice): number {
  if (choice.intent === "danger") return BUTTON_DANGER;
  if (choice.intent === "primary") return BUTTON_SUCCESS;
  return BUTTON_SECONDARY;
}

/** Render `message` as the content Discord shows: Markdown with broadcast pings defused. */
export function renderDiscordMessage(message: OutgoingMessage): string {
  return neutralizeBroadcastMentions(renderDiscordMarkdown(message.body));
}

/**
 * Choices as Discord components: buttons, five to a row, or a select menu past five, each
 * carrying a token for the prompt and choice it answers. A URL choice is a link button.
 */
export function choiceComponents(
  tokens: ChoiceTokens,
  choices: readonly Choice[],
  promptId: string | undefined,
): unknown[] {
  if (choices.length === 0) return [];
  const mint = (choice: Choice): string =>
    tokens.mint({ promptId: promptId ?? "", choiceId: choice.id });
  if (choices.length > BUTTONS_PER_ROW && choices.every((choice) => choice.url === undefined)) {
    // A select menu's options are its values; each value is a token like a button's id.
    const menuId = tokens.mint({ promptId: promptId ?? "", choiceId: "" });
    return [
      actionRow([
        stringSelect(
          menuId,
          "Choose…",
          choices.map((choice) => ({ label: choice.label, value: mint(choice) })),
        ),
      ]),
    ];
  }
  const buttons = choices.map((choice) =>
    choice.url === undefined
      ? button(mint(choice), choice.label, styleFor(choice))
      : { type: 2, style: BUTTON_LINK, label: choice.label.slice(0, 80), url: choice.url },
  );
  const rows: unknown[] = [];
  for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
    rows.push(actionRow(buttons.slice(index, index + BUTTONS_PER_ROW)));
  }
  return rows;
}

export function createDiscordSurface(options: { readonly botToken: string }): DiscordSurface {
  const tokens = createChoiceTokens();

  const componentsFor = (choices: readonly Choice[], promptId: string | undefined): unknown[] =>
    choiceComponents(tokens, choices, promptId);

  return {
    name: "discord",
    capabilities: CAPABILITIES,

    readChoice: (payload) => tokens.read(payload),

    async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined> {
      const chunks = splitForDiscord(renderDiscordMessage(message));
      const components =
        message.choices === undefined
          ? undefined
          : componentsFor(message.choices, message.promptId);
      let lastId: string | undefined;
      for (const [index, chunk] of chunks.entries()) {
        const isFirst = index === 0;
        const isLast = index === chunks.length - 1;
        const sent = await sendMessage(options.botToken, chatId, chunk, {
          // Components belong under the last chunk, a reply reference on the first.
          ...(isLast && components !== undefined ? { components } : {}),
          ...(isFirst && message.replyTo !== undefined
            ? { message_reference: { message_id: message.replyTo } }
            : {}),
        });
        lastId = sent?.id ?? lastId;
      }
      return lastId;
    },

    async edit(chatId: ChatId, ref: MessageRef, message: OutgoingMessage): Promise<void> {
      await editMessage(options.botToken, chatId, ref, renderDiscordMessage(message), {
        components:
          message.choices === undefined ? [] : componentsFor(message.choices, message.promptId),
      });
    },

    async setChoices(
      chatId: ChatId,
      ref: MessageRef,
      choices: readonly Choice[],
      promptId?: string,
    ): Promise<void> {
      await patchMessage(options.botToken, chatId, ref, {
        components: componentsFor(choices, promptId),
      });
    },

    async sendFile(chatId: ChatId, file: OutgoingFile, caption?: string): Promise<void> {
      // The bytes the core read from where it confined the file; the path is never reopened.
      await sendAttachment(
        options.botToken,
        chatId,
        new Blob([file.bytes]),
        file.filename,
        caption,
      );
    },

    async typing(chatId: ChatId): Promise<void> {
      await triggerTyping(options.botToken, chatId);
    },
  };
}
