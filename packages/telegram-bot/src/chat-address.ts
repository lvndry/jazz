/**
 * @fileoverview Where a Telegram conversation lives: a chat, or one topic inside it.
 *
 * A forum supergroup, and a private chat with a bot that has topic mode on, holds several
 * topics under one chat id. The shared core keys a conversation by an opaque `ChatId`, so the
 * topic is folded into that id here: every topic then gets its own history, its own run queue
 * and its own `/new`, with no change to the core. What belongs to the chat as a whole (its
 * sandbox, its agent, its timezone, its approval mode) is looked up by the chat id alone.
 */

import type { ChatId } from "@jazz/bot-shared/surface";

/** Splits the chat id from the topic in an address. Neither side can contain it. */
const TOPIC_SEPARATOR = "_";
const ADDRESS_PATTERN = /^(-?\d+)(?:_(\d+))?$/;

export interface ChatAddress {
  /** Telegram's chat id; negative for groups. */
  readonly chatId: number;
  /** The topic's `message_thread_id`, absent for a chat without topics and for General. */
  readonly topicId?: number;
}

/** The fields of a Telegram message that say which topic it was sent in. */
export interface TopicFields {
  readonly message_thread_id?: number;
  readonly is_topic_message?: boolean;
}

/**
 * The topic a message was sent in, or undefined outside one.
 *
 * `message_thread_id` alone is not enough: an ordinary supergroup sets it on every reply to
 * name the reply chain, and treating that as a topic would split one group chat into a
 * conversation per reply chain.
 */
export function topicIdOf(message: TopicFields): number | undefined {
  const threadId = message.message_thread_id;
  if (message.is_topic_message !== true || threadId === undefined) {
    return undefined;
  }
  // Telegram's thread ids are positive integers. Anything else would build an address no
  // reply can be sent to, so the message is treated as outside any topic instead.
  if (!Number.isSafeInteger(threadId) || threadId <= 0) {
    console.warn(`[topics] ignoring a malformed topic id: ${String(threadId)}`);
    return undefined;
  }
  return threadId;
}

export function formatChatAddress(address: ChatAddress): ChatId {
  return address.topicId === undefined
    ? String(address.chatId)
    : `${address.chatId}${TOPIC_SEPARATOR}${address.topicId}`;
}

/** The address a message was sent from. */
export function chatAddressOf(chatId: number, message: TopicFields): ChatId {
  const topicId = topicIdOf(message);
  return formatChatAddress(topicId === undefined ? { chatId } : { chatId, topicId });
}

/** Throws on an id this bridge did not build, since sending to a guessed chat is worse. */
export function parseChatAddress(address: ChatId): ChatAddress {
  const match = ADDRESS_PATTERN.exec(address);
  if (match === null) {
    throw new Error(`Not a Telegram chat address: ${address}`);
  }
  const chatId = Number.parseInt(match[1] ?? "", 10);
  return match[2] === undefined ? { chatId } : { chatId, topicId: Number.parseInt(match[2], 10) };
}

/** The chat an address belongs to, as the id chat-wide state is stored under. */
export function chatScopeOf(address: ChatId): string {
  return String(parseChatAddress(address).chatId);
}

/** `chat_id` and, inside a topic, `message_thread_id`: what a send needs to land there. */
export function destinationOf(address: ChatId): {
  readonly chat_id: number;
  readonly message_thread_id?: number;
} {
  const { chatId, topicId } = parseChatAddress(address);
  return topicId === undefined
    ? { chat_id: chatId }
    : { chat_id: chatId, message_thread_id: topicId };
}
