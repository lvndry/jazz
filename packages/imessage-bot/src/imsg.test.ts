import { describe, expect, test } from "bun:test";
import { chatLabel, parseChatLine, parseMessageLine } from "./imsg";

/**
 * Field names mirror `imsg`'s own `OutputModels.swift` CodingKeys. If a rename
 * lands upstream these are the assertions that catch it, rather than a bridge
 * that quietly answers nothing.
 */
const MESSAGE_LINE = JSON.stringify({
  id: 918_233,
  chat_id: 42,
  guid: "A1B2-C3",
  sender: "+33123456789",
  sender_name: "Alex",
  is_from_me: false,
  text: "what's on my calendar tomorrow?",
  created_at: "2026-09-09T08:14:03Z",
  attachments: [],
  reactions: [],
  is_reaction: false,
  reply_to_text: null,
});

const CHAT_LINE = JSON.stringify({
  id: 42,
  name: "Alex",
  identifier: "+33123456789",
  guid: "iMessage;-;+33123456789",
  display_name: null,
  contact_name: "Alex Dubois",
  is_group: false,
  participants: ["+33123456789"],
  service: "iMessage",
  last_message_at: "2026-09-09T08:14:03Z",
  unread_count: 1,
});

describe("parseMessageLine", () => {
  test("reads the fields the bridge routes on", () => {
    const message = parseMessageLine(MESSAGE_LINE);
    expect(message).toBeDefined();
    expect(message?.id).toBe(918_233);
    expect(message?.chatId).toBe(42);
    expect(message?.sender).toBe("+33123456789");
    expect(message?.senderName).toBe("Alex");
    expect(message?.isFromMe).toBe(false);
    expect(message?.text).toBe("what's on my calendar tomorrow?");
  });

  test("carries attachment paths, which is how media reaches the agent", () => {
    const withAttachment = JSON.stringify({
      ...JSON.parse(MESSAGE_LINE),
      text: "",
      attachments: [
        {
          filename: "IMG_0042.HEIC",
          transfer_name: "IMG_0042.HEIC",
          uti: "public.heic",
          mime_type: "image/heic",
          total_bytes: 2_400_000,
          is_sticker: false,
          original_path: "/Users/me/Library/Messages/Attachments/aa/IMG_0042.HEIC",
          converted_path: null,
          converted_mime_type: null,
          missing: false,
        },
      ],
    });
    const attachment = parseMessageLine(withAttachment)?.attachments[0];
    expect(attachment?.originalPath).toBe(
      "/Users/me/Library/Messages/Attachments/aa/IMG_0042.HEIC",
    );
    expect(attachment?.mimeType).toBe("image/heic");
    expect(attachment?.missing).toBe(false);
  });

  test("flags a tapback so it is not answered as a message", () => {
    const reaction = JSON.stringify({
      ...JSON.parse(MESSAGE_LINE),
      is_reaction: true,
      reaction_type: "like",
      reacted_to_guid: "A1B2-C3",
    });
    expect(parseMessageLine(reaction)?.isReaction).toBe(true);
  });

  test("skips a row missing the ids the bridge routes on, rather than throwing", () => {
    expect(parseMessageLine(JSON.stringify({ text: "hi" }))).toBeUndefined();
  });

  test("skips anything that is not JSON, which stderr chatter can be", () => {
    expect(parseMessageLine("warning: Contacts access not granted")).toBeUndefined();
    expect(parseMessageLine("")).toBeUndefined();
    expect(parseMessageLine("{ truncated")).toBeUndefined();
  });

  test("treats a missing text field as empty rather than failing the row", () => {
    const noText = JSON.stringify({ id: 1, chat_id: 2 });
    expect(parseMessageLine(noText)?.text).toBe("");
  });
});

describe("parseChatLine", () => {
  test("reads identity and group-ness, which the access decision turns on", () => {
    const chat = parseChatLine(CHAT_LINE);
    expect(chat?.id).toBe(42);
    expect(chat?.isGroup).toBe(false);
    expect(chat?.participants).toEqual(["+33123456789"]);
    expect(chat?.guid).toBe("iMessage;-;+33123456789");
  });

  test("reads a group chat", () => {
    const group = JSON.stringify({
      ...JSON.parse(CHAT_LINE),
      id: 77,
      is_group: true,
      display_name: "Crew",
      contact_name: null,
      participants: ["+33123456789", "+15551234567"],
    });
    const chat = parseChatLine(group);
    expect(chat?.isGroup).toBe(true);
    expect(chat?.participants).toHaveLength(2);
    expect(chatLabel(chat!)).toBe("Crew");
  });
});

describe("chatLabel", () => {
  test("prefers the Contacts name a person would recognise", () => {
    expect(chatLabel(parseChatLine(CHAT_LINE)!)).toBe("Alex Dubois");
  });

  test("falls back to the raw identifier when nothing is resolved", () => {
    const bare = JSON.stringify({
      id: 9,
      name: "",
      identifier: "+15551234567",
      is_group: false,
      service: "SMS",
    });
    expect(chatLabel(parseChatLine(bare)!)).toBe("+15551234567");
  });
});
