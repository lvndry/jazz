/**
 * Upload-reference cache behavior for large attachments.
 *
 * The AI SDK upload call is mocked because this suite verifies cache lifetime, not a provider
 * integration. Each path below resolves to one tiny fixture file while declaring a large byte
 * size, which exercises the provider-upload path without allocating hundreds of megabytes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { MessageAttachment } from "@jazz/core/types/attachment";
import type { ChatMessage } from "@jazz/core/types/message";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const actualAiModule = { ...(await import("ai")) };
let uploadCalls = 0;

mock.module("ai", () => ({
  ...actualAiModule,
  uploadFile: mock(async () => ({ providerReference: { upload: ++uploadCalls } })),
}));

const { ATTACHMENT_UPLOAD_CACHE_CAPACITY, clearAttachmentUploadCache, resolveAttachments } =
  await import("./attachment-resolver");

function largeVideo(path: string): MessageAttachment {
  return {
    kind: "video",
    mediaType: "video/mp4",
    path,
    byteSize: 7 * 1024 * 1024,
  };
}

async function resolveLargeVideo(path: string): Promise<void> {
  const messages: ChatMessage[] = [
    { role: "user", content: "watch", attachments: [largeVideo(path)] },
  ];
  await resolveAttachments(messages, "openai");
}

beforeEach(() => {
  clearAttachmentUploadCache();
  uploadCalls = 0;
});

afterEach(() => {
  clearAttachmentUploadCache();
});

afterAll(() => {
  mock.module("ai", () => actualAiModule);
});

describe("attachment upload cache", () => {
  it("evicts the least-recently-used reference while preserving a refreshed entry", async () => {
    const directory = await mkdtemp(`${tmpdir()}/jazz-attachment-cache-`);
    const fixture = `${directory}/clip.mp4`;
    await writeFile(fixture, "fixture");

    try {
      const pathAt = (index: number): string => `${directory}${"/.".repeat(index)}/clip.mp4`;

      for (let index = 0; index < ATTACHMENT_UPLOAD_CACHE_CAPACITY; index++) {
        await resolveLargeVideo(pathAt(index));
      }
      expect(uploadCalls).toBe(ATTACHMENT_UPLOAD_CACHE_CAPACITY);

      await resolveLargeVideo(pathAt(0));
      await resolveLargeVideo(pathAt(ATTACHMENT_UPLOAD_CACHE_CAPACITY));
      await resolveLargeVideo(pathAt(0));
      await resolveLargeVideo(pathAt(1));

      expect(uploadCalls).toBe(ATTACHMENT_UPLOAD_CACHE_CAPACITY + 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
