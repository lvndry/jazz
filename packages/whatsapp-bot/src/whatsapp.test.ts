import { describe, expect, test } from "bun:test";
import { agentIdForChat, jidFromAgentId } from "./agents";
import { flattenMessage } from "./whatsapp";

function dm(message: Record<string, unknown>, key: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: "33761157947@s.whatsapp.net", id: "3EB0", fromMe: false, ...key },
    pushName: "Alex",
    message,
  };
}

describe("flattenMessage", () => {
  test("reads a plain text message", () => {
    const flat = flattenMessage(dm({ conversation: "what's on my calendar?" }));
    expect(flat?.text).toBe("what's on my calendar?");
    expect(flat?.chatJid).toBe("33761157947@s.whatsapp.net");
    expect(flat?.senderJid).toBe("33761157947@s.whatsapp.net");
    expect(flat?.isFromMe).toBe(false);
  });

  test("reads the text of a reply, which arrives in a different field", () => {
    const flat = flattenMessage(
      dm({ extendedTextMessage: { text: "and the day after?", contextInfo: {} } }),
    );
    expect(flat?.text).toBe("and the day after?");
  });

  test("attributes a group message to the participant, not the group", () => {
    const flat = flattenMessage(
      dm(
        { conversation: "hi" },
        { remoteJid: "120363042@g.us", participant: "33761157947@s.whatsapp.net" },
      ),
    );
    expect(flat?.chatJid).toBe("120363042@g.us");
    expect(flat?.senderJid).toBe("33761157947@s.whatsapp.net");
  });

  test("carries mentions and the quoted author, which decide group addressing", () => {
    const flat = flattenMessage(
      dm({
        extendedTextMessage: {
          text: "@bot what about friday",
          contextInfo: {
            mentionedJid: ["15550001111@s.whatsapp.net"],
            participant: "15550001111@s.whatsapp.net",
          },
        },
      }),
    );
    expect(flat?.mentions).toEqual(["15550001111@s.whatsapp.net"]);
    expect(flat?.quotedAuthor).toBe("15550001111@s.whatsapp.net");
  });

  test("leaves quotedAuthor unset when nothing was quoted", () => {
    expect(flattenMessage(dm({ conversation: "hi" }))?.quotedAuthor).toBeUndefined();
  });

  test("keeps an image with no caption, since the image is the message", () => {
    const flat = flattenMessage(dm({ imageMessage: { mimetype: "image/jpeg" } }));
    expect(flat?.media?.kind).toBe("image");
    expect(flat?.media?.mimeType).toBe("image/jpeg");
    expect(flat?.text).toBe("");
  });

  test("reads an image caption as the text", () => {
    const flat = flattenMessage(
      dm({ imageMessage: { mimetype: "image/jpeg", caption: "what is this?" } }),
    );
    expect(flat?.text).toBe("what is this?");
    expect(flat?.media?.kind).toBe("image");
  });

  test("drops status broadcasts, which are everyone's stories", () => {
    const flat = flattenMessage(dm({ conversation: "hi" }, { remoteJid: "status@broadcast" }));
    expect(flat).toBeUndefined();
  });

  test("drops protocol traffic that carries nothing to answer", () => {
    expect(flattenMessage(dm({ protocolMessage: { type: 3 } }))).toBeUndefined();
    expect(flattenMessage(dm({ reactionMessage: { text: "👍" } }))).toBeUndefined();
    expect(flattenMessage({ key: { remoteJid: "x@s.whatsapp.net", id: "1" } })).toBeUndefined();
    expect(flattenMessage(undefined)).toBeUndefined();
  });
});

describe("agent ids", () => {
  test("round-trip a DM jid", () => {
    const jid = "33761157947@s.whatsapp.net";
    expect(jidFromAgentId(agentIdForChat(jid))).toBe(jid);
  });

  test("round-trip a group jid", () => {
    const jid = "120363042@g.us";
    expect(jidFromAgentId(agentIdForChat(jid))).toBe(jid);
  });

  test("a group and a DM with the same digits do not collide", () => {
    expect(agentIdForChat("120363042@g.us")).not.toBe(agentIdForChat("120363042@s.whatsapp.net"));
  });

  test("ignores an agent id belonging to another bridge sharing the data directory", () => {
    expect(jidFromAgentId("tg_12345")).toBeUndefined();
    expect(jidFromAgentId("im_42")).toBeUndefined();
  });
});
