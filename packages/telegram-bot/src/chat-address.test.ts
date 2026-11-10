import { describe, expect, test } from "bun:test";
import {
  chatAddressOf,
  chatScopeOf,
  destinationOf,
  formatChatAddress,
  parseChatAddress,
  topicIdOf,
} from "./chat-address";

describe("topicIdOf", () => {
  test("a message in a topic names its topic", () => {
    expect(topicIdOf({ message_thread_id: 7, is_topic_message: true })).toBe(7);
  });

  test("a reply chain in an ordinary supergroup is not a topic", () => {
    expect(topicIdOf({ message_thread_id: 7 })).toBeUndefined();
  });

  test("a message outside any topic has none", () => {
    expect(topicIdOf({})).toBeUndefined();
  });
});

describe("chat addresses", () => {
  test("a chat without topics keeps its bare id, so existing conversations are found again", () => {
    expect(chatAddressOf(1001, {})).toBe("1001");
    expect(chatAddressOf(-100500, { message_thread_id: 3 })).toBe("-100500");
  });

  test("a topic's address reads back as the same chat and topic", () => {
    const address = chatAddressOf(-100500, { message_thread_id: 42, is_topic_message: true });
    expect(parseChatAddress(address)).toEqual({ chatId: -100500, topicId: 42 });
    expect(formatChatAddress(parseChatAddress(address))).toBe(address);
  });

  test("every topic of a chat shares the chat's scope", () => {
    expect(chatScopeOf(formatChatAddress({ chatId: -100500, topicId: 42 }))).toBe("-100500");
    expect(chatScopeOf(formatChatAddress({ chatId: -100500, topicId: 43 }))).toBe("-100500");
    expect(chatScopeOf("1001")).toBe("1001");
  });

  test("a send is addressed to the topic only when there is one", () => {
    expect(destinationOf("1001")).toEqual({ chat_id: 1001 });
    expect(destinationOf(formatChatAddress({ chatId: 1001, topicId: 9 }))).toEqual({
      chat_id: 1001,
      message_thread_id: 9,
    });
  });

  test("refuses an id it did not build instead of guessing a chat from it", () => {
    expect(() => parseChatAddress("1001abc")).toThrow();
    expect(() => parseChatAddress("")).toThrow();
    expect(() => parseChatAddress("1001_")).toThrow();
  });
});
