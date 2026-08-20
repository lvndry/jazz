/**
 * Conversion of attachments into provider file parts.
 *
 * The invariants under test are the ones that fail silently in production: an attachment that
 * reaches the model as nothing at all, and an estimate that disagrees with what is actually
 * sent.
 */

import { describe, expect, it } from "bun:test";
import type { MessageAttachment } from "@/core/types/attachment";
import type { ChatMessage } from "@/core/types/message";
import { toCoreMessages } from "./ai-sdk-service";
import type { ResolvedAttachment } from "./attachment-resolver";

function imageAttachment(path = "/tmp/shot.png"): MessageAttachment {
  return {
    kind: "image",
    mediaType: "image/png",
    path,
    byteSize: 2048,
    width: 800,
    height: 600,
  };
}

function resolvedBytes(path: string): ReadonlyMap<string, ResolvedAttachment> {
  return new Map([
    [path, { kind: "bytes", data: new Uint8Array([1, 2, 3]) } as ResolvedAttachment],
  ]);
}

type UserContent = Array<{ type: string; text?: string; mediaType?: string }>;

function userParts(message: { content: unknown }): UserContent {
  return message.content as UserContent;
}

describe("toCoreMessages — attachments", () => {
  it("emits a file part carrying the media type", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "what is this?", attachments: [imageAttachment()] },
    ];
    const converted = toCoreMessages(messages, "anthropic", resolvedBytes("/tmp/shot.png"));

    const parts = userParts(converted[0]!);
    const filePart = parts.find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    expect(filePart?.mediaType).toBe("image/png");
  });

  it("keeps the user's text alongside the file", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "what is this?", attachments: [imageAttachment()] },
    ];
    const parts = userParts(
      toCoreMessages(messages, "anthropic", resolvedBytes("/tmp/shot.png"))[0]!,
    );
    expect(parts.find((part) => part.type === "text")?.text).toContain("what is this?");
  });

  it("uses one code path for every modality — audio and video included", () => {
    for (const attachment of [
      { kind: "audio", mediaType: "audio/ogg", path: "/tmp/a.ogg", byteSize: 100 },
      { kind: "video", mediaType: "video/mp4", path: "/tmp/v.mp4", byteSize: 100 },
      { kind: "pdf", mediaType: "application/pdf", path: "/tmp/d.pdf", byteSize: 100 },
    ] as MessageAttachment[]) {
      const converted = toCoreMessages(
        [{ role: "user", content: "look", attachments: [attachment] }],
        "gemini",
        resolvedBytes(attachment.path),
      );
      const filePart = userParts(converted[0]!).find((part) => part.type === "file");
      expect(filePart?.mediaType).toBe(attachment.mediaType);
    }
  });

  it("passes an uploaded reference through instead of bytes", () => {
    const attachment: MessageAttachment = {
      kind: "video",
      mediaType: "video/mp4",
      path: "/tmp/clip.mp4",
      byteSize: 50 * 1024 * 1024,
    };
    const reference = { uri: "files/abc123" };
    const resolved = new Map<string, ResolvedAttachment>([
      [attachment.path, { kind: "reference", reference }],
    ]);

    const converted = toCoreMessages(
      [{ role: "user", content: "watch", attachments: [attachment] }],
      "gemini",
      resolved,
    );
    const filePart = userParts(converted[0]!).find((part) => part.type === "file") as
      { data?: unknown } | undefined;
    expect(filePart?.data).toBe(reference);
  });

  it("tells the model when an attachment could not be sent, rather than dropping it silently", () => {
    // This is the failure that matters most: handed nothing, a model describes an image it
    // never saw.
    const attachment = imageAttachment();
    const resolved = new Map<string, ResolvedAttachment>([
      [attachment.path, { kind: "unavailable", reason: "moved or deleted" }],
    ]);

    const parts = userParts(
      toCoreMessages(
        [{ role: "user", content: "what is this?", attachments: [attachment] }],
        "anthropic",
        resolved,
      )[0]!,
    );
    expect(parts.some((part) => part.type === "file")).toBe(false);
    const text = parts.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("moved or deleted");
    expect(text).toContain("/tmp/shot.png");
  });

  it("notes an attachment whose payload is missing from the resolved map", () => {
    const parts = userParts(
      toCoreMessages(
        [{ role: "user", content: "hi", attachments: [imageAttachment()] }],
        "anthropic",
        new Map(),
      )[0]!,
    );
    expect(parts.some((part) => part.type === "file")).toBe(false);
    expect(parts.find((part) => part.type === "text")?.text).toContain("/tmp/shot.png");
  });

  it("leaves plain messages as a bare string, unchanged", () => {
    const converted = toCoreMessages([{ role: "user", content: "just text" }], "anthropic");
    expect(converted[0]?.content).toBe("just text");
  });

  it("ages attachments out past the inline window, keeping the path in text", () => {
    const old = imageAttachment("/tmp/old.png");
    const recent = imageAttachment("/tmp/recent.png");
    const messages: ChatMessage[] = [
      { role: "user", content: "first", attachments: [old] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third", attachments: [recent] },
    ];
    const resolved = new Map<string, ResolvedAttachment>([
      [old.path, { kind: "bytes", data: new Uint8Array([1]) }],
      [recent.path, { kind: "bytes", data: new Uint8Array([1]) }],
    ]);

    const converted = toCoreMessages(messages, "anthropic", resolved);

    // Oldest user turn is outside the two-turn window: described, not inlined.
    const oldParts = userParts(converted[0]!);
    expect(oldParts.some((part) => part.type === "file")).toBe(false);
    expect(oldParts.find((part) => part.type === "text")?.text).toContain("/tmp/old.png");

    // Most recent user turn keeps its file part.
    const recentParts = userParts(converted[4]!);
    expect(recentParts.some((part) => part.type === "file")).toBe(true);
  });
});
