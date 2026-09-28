import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

test("importing the bridge exposes an entry point without starting one", async () => {
  // The module used to call start() at import time, which is why there was no
  // `jazz whatsapp`: a CLI command could not load it to read anything out of it
  // without launching a linked device as a side effect.
  const bridge = await import("./bridge");
  expect(typeof bridge.startBridge).toBe("function");
});

test("saves an allow-list as typed, so the file stays editable by hand", async () => {
  const { saveAllowList, readSavedAllowList, allowListPath } = await import("./bridge");
  const home = mkdtempSync(join(tmpdir(), "jazz-wa-"));
  saveAllowList(home, "+15551234567, +33123456789");
  expect(readSavedAllowList(home)).toBe("+15551234567, +33123456789");
  expect(JSON.parse(readFileSync(allowListPath(home), "utf8"))).toEqual({
    allowedNumbers: "+15551234567, +33123456789",
  });
});

test("an unanswered home reads as no allow-list rather than throwing", async () => {
  const { readSavedAllowList } = await import("./bridge");
  expect(readSavedAllowList(mkdtempSync(join(tmpdir(), "jazz-wa-empty-")))).toBe("");
});

describe("unaddressed group messages while the requester's prompt waits", () => {
  const GROUP_ID = "120363000000000001";
  const GROUP = `${GROUP_ID}@g.us`;
  const REQUESTER = "15551234567@s.whatsapp.net";

  async function deliver(text: string, options: { answers: boolean; media?: boolean }) {
    const { handleIncoming } = await import("./bridge");
    const handled: string[] = [];
    const answered: string[] = [];
    const mediaSaved: string[] = [];
    const runner = {
      awaitsReplyFrom: () => true,
      tryAnswerPending: (message: { text: string }) => {
        answered.push(message.text);
        return Promise.resolve(options.answers);
      },
      handle: (message: { text: string }) => {
        handled.push(message.text);
        return Promise.resolve();
      },
    };
    const connection = {
      selfJid: "15550000000@s.whatsapp.net",
      saveMedia: () => {
        mediaSaved.push("saved");
        return Promise.resolve("/tmp/photo.jpg");
      },
    };
    await handleIncoming(
      {
        allowedNumbers: new Set(),
        allowedGroups: new Set([GROUP_ID]),
        requireMentionInGroups: true,
        jazzHome: mkdtempSync(join(tmpdir(), "jazz-wa-pending-")),
      } as unknown as Parameters<typeof handleIncoming>[0],
      runner as unknown as Parameters<typeof handleIncoming>[1],
      connection as unknown as Parameters<typeof handleIncoming>[2],
      {
        id: "m1",
        chatJid: GROUP,
        senderJid: REQUESTER,
        pushName: undefined,
        text,
        isFromMe: false,
        mentions: [],
        quotedAuthor: undefined,
        media:
          options.media === true
            ? { kind: "image", mimeType: "image/jpeg", fileName: undefined }
            : undefined,
      } as unknown as Parameters<typeof handleIncoming>[3],
    );
    return { handled, answered, mediaSaved };
  }

  test("a matching reply answers the prompt", async () => {
    const { handled, answered } = await deliver("1", { answers: true });
    expect(answered).toEqual(["1"]);
    expect(handled).toEqual([]);
  });

  test("unrelated chatter is dropped, never queued as a prompt, and its media is not saved", async () => {
    const { handled, answered, mediaSaved } = await deliver("lunch?", {
      answers: false,
      media: true,
    });
    expect(answered).toEqual(["lunch?"]);
    expect(handled).toEqual([]);
    expect(mediaSaved).toEqual([]);
  });
});
