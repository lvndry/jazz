import { describe, expect, test } from "bun:test";
import {
  type AccessConfig,
  decideAccess,
  normalizeHandle,
  parseChatIdList,
  parseHandleList,
} from "./access";

describe("normalizeHandle", () => {
  test("strips the punctuation a human types into a config file", () => {
    expect(normalizeHandle("+33 (7) 61-15.79 47")).toBe("+33761157947");
  });

  test("treats a 00 international prefix as +", () => {
    expect(normalizeHandle("0033761157947")).toBe("+33761157947");
  });

  test("lowercases an Apple ID but leaves its shape alone", () => {
    expect(normalizeHandle("  Landry@Lysk.AI ")).toBe("landry@lysk.ai");
  });

  test("leaves a bare national number unmatched rather than guessing a country", () => {
    expect(normalizeHandle("0761157947")).not.toBe(normalizeHandle("+33761157947"));
  });
});

describe("decideAccess", () => {
  const config: AccessConfig = {
    allowedHandles: parseHandleList("+33761157947, landry@lysk.ai"),
    allowedGroupChatIds: parseChatIdList("42"),
  };

  test("admits a listed handle in a direct message", () => {
    expect(
      decideAccess(config, { sender: "+33 761 157 947", chatId: 7, isGroup: false }).allowed,
    ).toBe(true);
  });

  test("refuses an unlisted handle", () => {
    const decision = decideAccess(config, {
      sender: "+15551234567",
      chatId: 8,
      isGroup: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("+15551234567");
  });

  test("refuses a group that was not listed, even from an allowed sender", () => {
    expect(
      decideAccess(config, { sender: "+33761157947", chatId: 99, isGroup: true }).allowed,
    ).toBe(false);
  });

  test("admits any participant of a listed group, which is what listing it meant", () => {
    expect(
      decideAccess(config, { sender: "+15551234567", chatId: 42, isGroup: true }).allowed,
    ).toBe(true);
  });

  test("does not let a listed handle open an unlisted group by being in it", () => {
    const openConfig: AccessConfig = {
      allowedHandles: parseHandleList("+33761157947"),
      allowedGroupChatIds: new Set<number>(),
    };
    expect(
      decideAccess(openConfig, { sender: "+33761157947", chatId: 5, isGroup: true }).allowed,
    ).toBe(false);
  });
});

describe("parseHandleList", () => {
  test("drops empty entries from a trailing comma", () => {
    expect(parseHandleList("+33761157947, ,")).toEqual(new Set(["+33761157947"]));
  });

  test("an empty list admits nobody", () => {
    expect(parseHandleList("").size).toBe(0);
  });
});
