import { describe, expect, it } from "bun:test";
import type { MessageAttachment } from "@/core/types/attachment";
import { estimateAttachmentsTokens, estimateAttachmentTokens } from "./attachment-tokens";

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    kind: "image",
    mediaType: "image/png",
    path: "/tmp/shot.png",
    byteSize: 1024,
    ...overrides,
  };
}

describe("estimateAttachmentTokens", () => {
  it("prices an image by pixel area", () => {
    // Anthropic's documented formula: width * height / 750.
    expect(estimateAttachmentTokens(attachment({ width: 750, height: 100 }))).toBe(100);
  });

  it("caps an enormous image, since providers downscale before billing", () => {
    const huge = estimateAttachmentTokens(attachment({ width: 8000, height: 8000 }));
    const large = estimateAttachmentTokens(attachment({ width: 4000, height: 4000 }));
    expect(huge).toBe(large);
    expect(huge).toBeLessThan(4_000);
  });

  it("prices audio and video by duration, not bytes", () => {
    const shortAudio = estimateAttachmentTokens(
      attachment({ kind: "audio", mediaType: "audio/ogg", durationSeconds: 10, byteSize: 1 }),
    );
    const longAudio = estimateAttachmentTokens(
      attachment({
        kind: "audio",
        mediaType: "audio/ogg",
        durationSeconds: 100,
        byteSize: 10_000_000,
      }),
    );
    expect(longAudio).toBe(shortAudio * 10);
  });

  it("prices video well above audio of the same length — it bills sampled frames too", () => {
    const audio = estimateAttachmentTokens(
      attachment({ kind: "audio", mediaType: "audio/ogg", durationSeconds: 30 }),
    );
    const video = estimateAttachmentTokens(
      attachment({ kind: "video", mediaType: "video/mp4", durationSeconds: 30 }),
    );
    expect(video).toBeGreaterThan(audio * 5);
  });

  it("prices a native PDF per page", () => {
    const onePage = estimateAttachmentTokens(
      attachment({ kind: "pdf", mediaType: "application/pdf", pageCount: 1 }),
    );
    expect(
      estimateAttachmentTokens(
        attachment({ kind: "pdf", mediaType: "application/pdf", pageCount: 10 }),
      ),
    ).toBe(onePage * 10);
  });

  it("falls back to a non-trivial estimate when the shape was never probed", () => {
    // The bias must be toward over-estimating: under-estimating costs a failed request, while
    // over-estimating only costs a slightly early compaction.
    for (const kind of ["image", "pdf", "audio", "video"] as const) {
      const estimate = estimateAttachmentTokens(attachment({ kind }));
      expect(estimate).toBeGreaterThan(1_000);
    }
  });

  it("assumes an unprobed video is expensive", () => {
    const unprobed = estimateAttachmentTokens(
      attachment({ kind: "video", mediaType: "video/mp4" }),
    );
    expect(unprobed).toBeGreaterThan(10_000);
  });
});

describe("estimateAttachmentsTokens", () => {
  it("is zero for no attachments", () => {
    expect(estimateAttachmentsTokens(undefined)).toBe(0);
    expect(estimateAttachmentsTokens([])).toBe(0);
  });

  it("sums across attachments", () => {
    const one = attachment({ width: 750, height: 100 });
    expect(estimateAttachmentsTokens([one, one])).toBe(200);
  });
});
