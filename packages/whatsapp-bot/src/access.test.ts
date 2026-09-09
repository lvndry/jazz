import { describe, expect, test } from "bun:test";
import { type AccessConfig, decideAccess, isGroupJid, normalizeJid, parseJidList } from "./access";

describe("normalizeJid", () => {
  test("reduces a DM jid to its digits", () => {
    expect(normalizeJid("33761157947@s.whatsapp.net")).toBe("33761157947");
  });

  test("drops the device suffix a linked device adds", () => {
    expect(normalizeJid("33761157947:12@s.whatsapp.net")).toBe("33761157947");
  });

  test("matches a hand-written number against the jid form", () => {
    expect(normalizeJid("+33 7 61 15 79 47")).toBe(normalizeJid("33761157947@s.whatsapp.net"));
  });

  test("normalises a group id the same way on both sides of a comparison", () => {
    // A real group id is digits, sometimes `<creator>-<timestamp>` on older
    // groups. What matters is not which characters survive but that an
    // allow-list entry and an incoming jid land on the same string.
    expect(normalizeJid("120363042@g.us")).toBe(normalizeJid("120363042"));
    expect(normalizeJid("33761157947-1600000000@g.us")).toBe(
      normalizeJid("33761157947-1600000000"),
    );
  });

  test("keeps a non-numeric identifier, which newer accounts use", () => {
    expect(normalizeJid("8a3f9b2c@lid")).toBe("8a3f9b2c");
  });
});

describe("isGroupJid", () => {
  test("distinguishes a group from a person", () => {
    expect(isGroupJid("120363042@g.us")).toBe(true);
    expect(isGroupJid("33761157947@s.whatsapp.net")).toBe(false);
  });
});

describe("decideAccess", () => {
  const config: AccessConfig = {
    allowedNumbers: parseJidList("+33761157947"),
    allowedGroups: parseJidList("120363042@g.us"),
    requireMentionInGroups: true,
  };

  test("admits a listed number in a DM", () => {
    expect(
      decideAccess(config, {
        chatJid: "33761157947@s.whatsapp.net",
        senderJid: "33761157947@s.whatsapp.net",
        addressesBot: false,
      }).allowed,
    ).toBe(true);
  });

  test("refuses an unlisted number", () => {
    expect(
      decideAccess(config, {
        chatJid: "15551234567@s.whatsapp.net",
        senderJid: "15551234567@s.whatsapp.net",
        addressesBot: true,
      }).allowed,
    ).toBe(false);
  });

  test("stays quiet in an allowed group until the bot is addressed", () => {
    const unaddressed = decideAccess(config, {
      chatJid: "120363042@g.us",
      senderJid: "33761157947@s.whatsapp.net",
      addressesBot: false,
    });
    expect(unaddressed.allowed).toBe(false);
    expect(unaddressed.allowed === false && unaddressed.reason).toContain("did not address");

    expect(
      decideAccess(config, {
        chatJid: "120363042@g.us",
        senderJid: "33761157947@s.whatsapp.net",
        addressesBot: true,
      }).allowed,
    ).toBe(true);
  });

  test("answers every message in a group when the mention rule is off", () => {
    const chatty: AccessConfig = { ...config, requireMentionInGroups: false };
    expect(
      decideAccess(chatty, {
        chatJid: "120363042@g.us",
        senderJid: "15551234567@s.whatsapp.net",
        addressesBot: false,
      }).allowed,
    ).toBe(true);
  });

  test("refuses an unlisted group even when the bot is mentioned", () => {
    expect(
      decideAccess(config, {
        chatJid: "999999@g.us",
        senderJid: "33761157947@s.whatsapp.net",
        addressesBot: true,
      }).allowed,
    ).toBe(false);
  });

  test("does not admit a group member to a DM by way of the group", () => {
    expect(
      decideAccess(config, {
        chatJid: "15551234567@s.whatsapp.net",
        senderJid: "15551234567@s.whatsapp.net",
        addressesBot: true,
      }).allowed,
    ).toBe(false);
  });
});
