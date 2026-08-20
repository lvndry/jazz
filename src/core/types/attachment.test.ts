import { describe, expect, it } from "bun:test";
import {
  ATTACHMENT_INLINE_TURN_WINDOW,
  maxAttachmentBytes,
  classifyAttachmentPath,
  describeAttachment,
  INLINE_BYTE_LIMIT,
  inlineAttachmentMessageIndices,
  isAttachmentPath,
  MAX_ATTACHMENT_BYTES,
  type MessageAttachment,
  rejectAttachmentReason,
  requiresProviderUpload,
} from "./attachment";

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    kind: "image",
    mediaType: "image/png",
    path: "/tmp/shot.png",
    byteSize: 1024,
    ...overrides,
  };
}

describe("classifyAttachmentPath", () => {
  it("maps each modality's extensions", () => {
    expect(classifyAttachmentPath("/a/b.png")).toEqual({ kind: "image", mediaType: "image/png" });
    expect(classifyAttachmentPath("/a/b.pdf")).toEqual({
      kind: "pdf",
      mediaType: "application/pdf",
    });
    expect(classifyAttachmentPath("/a/b.ogg")).toEqual({ kind: "audio", mediaType: "audio/ogg" });
    expect(classifyAttachmentPath("/a/b.mp4")).toEqual({ kind: "video", mediaType: "video/mp4" });
  });

  it("is case-insensitive on the extension", () => {
    expect(classifyAttachmentPath("/a/SHOT.PNG")?.kind).toBe("image");
    expect(classifyAttachmentPath("/a/clip.MoV")?.kind).toBe("video");
  });

  it("returns null for non-media and extensionless paths", () => {
    expect(classifyAttachmentPath("/a/b.ts")).toBeNull();
    expect(classifyAttachmentPath("/a/Makefile")).toBeNull();
    expect(isAttachmentPath("/a/b.txt")).toBe(false);
  });

  it("does not treat a dot in a parent directory as an extension", () => {
    // "/a.b/file" would otherwise classify on ".b/file".
    expect(classifyAttachmentPath("/pictures.old/screenshot")).toBeNull();
  });
});

describe("rejectAttachmentReason", () => {
  it("accepts a file inside its modality's limit", () => {
    expect(rejectAttachmentReason(attachment())).toBeNull();
  });

  it("rejects a file over its modality's limit, naming the size", () => {
    const oversized = attachment({ byteSize: MAX_ATTACHMENT_BYTES.image + 1 });
    const reason = rejectAttachmentReason(oversized);
    expect(reason).toContain("over the 5 MB per-image limit");
    expect(reason).toContain("/tmp/shot.png");
  });

  it("applies per-modality limits, not one global limit", () => {
    // A size that is too large for an image is fine for a PDF.
    const size = MAX_ATTACHMENT_BYTES.image + 1;
    expect(rejectAttachmentReason(attachment({ byteSize: size }))).not.toBeNull();
    expect(
      rejectAttachmentReason(
        attachment({ kind: "pdf", mediaType: "application/pdf", byteSize: size }),
      ),
    ).toBeNull();
  });

  it("relaxes the limit for a locally-served model", () => {
    // Every remote limit is somebody's API limit. Localhost has none, so enforcing Anthropic's
    // 5MB image cap against Ollama rejects a file that would have worked.
    const oversized = attachment({ byteSize: MAX_ATTACHMENT_BYTES.image * 2 });
    expect(rejectAttachmentReason(oversized, false)).not.toBeNull();
    expect(rejectAttachmentReason(oversized, true)).toBeNull();
  });

  it("tells the model what to do about an oversized file, not just that it failed", () => {
    // "Too big" alone gets relayed as a flat "I cannot see the image", which reads as a missing
    // capability rather than a fixable file.
    const reason = rejectAttachmentReason(attachment({ byteSize: MAX_ATTACHMENT_BYTES.image + 1 }));
    expect(reason).toContain("resizing");
  });

  it("still guards against an absurd local file", () => {
    const absurd = attachment({ byteSize: 1024 * 1024 * 1024 });
    expect(rejectAttachmentReason(absurd, true)).not.toBeNull();
  });

  it("rejects an empty file", () => {
    expect(rejectAttachmentReason(attachment({ byteSize: 0 }))).toContain("is empty");
  });
});

describe("maxAttachmentBytes", () => {
  it("returns the modality's remote limit by default", () => {
    expect(maxAttachmentBytes("image")).toBe(MAX_ATTACHMENT_BYTES.image);
    expect(maxAttachmentBytes("pdf")).toBe(MAX_ATTACHMENT_BYTES.pdf);
  });

  it("returns one generous ceiling for local models, regardless of modality", () => {
    expect(maxAttachmentBytes("image", true)).toBe(maxAttachmentBytes("video", true));
    expect(maxAttachmentBytes("image", true)).toBeGreaterThan(MAX_ATTACHMENT_BYTES.video);
  });
});

describe("requiresProviderUpload", () => {
  it("inlines below the limit and uploads above it", () => {
    expect(requiresProviderUpload(attachment({ byteSize: INLINE_BYTE_LIMIT }))).toBe(false);
    expect(requiresProviderUpload(attachment({ byteSize: INLINE_BYTE_LIMIT + 1 }))).toBe(true);
  });

  it("never uploads for a local provider — there is nothing to upload to", () => {
    const large = attachment({ byteSize: INLINE_BYTE_LIMIT * 10 });
    expect(requiresProviderUpload(large, false)).toBe(true);
    expect(requiresProviderUpload(large, true)).toBe(false);
  });

  it("routes a large video to upload — no provider takes video inline", () => {
    expect(
      requiresProviderUpload(
        attachment({ kind: "video", mediaType: "video/mp4", byteSize: 50 * 1024 * 1024 }),
      ),
    ).toBe(true);
  });
});

describe("describeAttachment", () => {
  it("always names the path so the model can re-read the file", () => {
    expect(describeAttachment(attachment())).toContain("/tmp/shot.png");
  });

  it("includes whichever shape metadata was probed", () => {
    const described = describeAttachment(attachment({ width: 800, height: 600 }));
    expect(described).toContain("800×600");

    const audio = describeAttachment(
      attachment({ kind: "audio", mediaType: "audio/ogg", durationSeconds: 12.5 }),
    );
    expect(audio).toContain("12.5s");
  });

  it("omits metadata that was not probed rather than guessing", () => {
    const described = describeAttachment(attachment());
    expect(described).not.toContain("×");
    expect(described).not.toContain("undefined");
  });
});

describe("inlineAttachmentMessageIndices", () => {
  it("keeps the most recent user turns, counted in turns not messages", () => {
    const messages = [
      { role: "system" },
      { role: "user" }, // 1 — oldest, outside the window
      { role: "assistant" },
      { role: "tool" },
      { role: "user" }, // 4
      { role: "assistant" },
      { role: "tool" },
      { role: "tool" },
      { role: "user" }, // 8 — newest
    ];
    const indices = inlineAttachmentMessageIndices(messages);
    expect(indices.size).toBe(ATTACHMENT_INLINE_TURN_WINDOW);
    expect(indices.has(8)).toBe(true);
    expect(indices.has(4)).toBe(true);
    expect(indices.has(1)).toBe(false);
  });

  it("is not thrown off by a turn that fanned out many tool calls", () => {
    // One user turn followed by twenty tool messages must still count as one turn.
    const messages = [
      { role: "user" }, // 0
      ...Array.from({ length: 20 }, () => ({ role: "tool" })),
      { role: "user" }, // 21
    ];
    const indices = inlineAttachmentMessageIndices(messages);
    expect(indices.has(0)).toBe(true);
    expect(indices.has(21)).toBe(true);
  });

  it("handles fewer user turns than the window", () => {
    expect(inlineAttachmentMessageIndices([{ role: "user" }]).has(0)).toBe(true);
    expect(inlineAttachmentMessageIndices([{ role: "system" }]).size).toBe(0);
  });
});
