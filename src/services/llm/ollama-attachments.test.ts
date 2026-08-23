/**
 * Attachment capabilities for local Ollama models.
 *
 * Both behaviours here were established by running against a real Ollama host, not read off a
 * spec, because the two sources disagree: the *model* advertises what it can do, and the
 * *provider* decides what it can transport. Where they differ, the narrower one wins.
 */

import { describe, expect, it } from "bun:test";
import type { ModelsDevMetadata } from "@/core/utils/models-dev";
import { resolveOllamaAttachmentSupport } from "./model-fetcher";

function devMetadata(overrides: Partial<ModelsDevMetadata> = {}): ModelsDevMetadata {
  return {
    contextWindow: 128_000,
    supportsTools: true,
    isReasoningModel: false,
    supportsVision: false,
    supportsPdf: false,
    supportsAudio: false,
    supportsVideo: false,
    generatesImage: false,
    generatesAudio: false,
    generatesVideo: false,
    supportsTemperature: true,
    ...overrides,
  };
}

describe("resolveOllamaAttachmentSupport", () => {
  it("trusts a vision capability the host reports, even when the catalog has never heard of the model", () => {
    // The reason this function exists: most local tags are absent from models.dev, so falling
    // back to the catalog alone would treat a working vision model as text-only.
    const support = resolveOllamaAttachmentSupport(
      ["completion", "vision", "tools", "thinking"],
      undefined,
    );
    expect(support.supportsVision).toBe(true);
  });

  it("refuses audio even when the model advertises it", () => {
    // Verified against a real host: gemma4:12b reports `audio`, but
    // ollama-ai-provider-v2 only converts image/* file parts and raises
    // "file part media type audio/ogg not supported" mid-request. Claiming audio here turns a
    // clean up-front refusal into a hard failure several seconds into a run.
    const support = resolveOllamaAttachmentSupport(
      ["completion", "vision", "audio", "tools", "thinking"],
      undefined,
    );
    expect(support.supportsAudio).toBe(false);
  });

  it("does not claim audio or PDF even when the catalog does", () => {
    // The transport limit is the provider's, so a catalog entry cannot override it.
    const support = resolveOllamaAttachmentSupport(
      ["completion", "vision"],
      devMetadata({ supportsAudio: true, supportsPdf: true }),
    );
    expect(support.supportsAudio).toBe(false);
    expect(support.supportsPdf).toBe(false);
  });

  it("reports nothing for a text-only local model", () => {
    const support = resolveOllamaAttachmentSupport(["completion", "tools"], undefined);
    expect(support.supportsVision).toBe(false);
    expect(support.supportsAudio).toBe(false);
    expect(support.supportsPdf).toBe(false);
  });

  it("falls back to the catalog's vision flag when the host reports no capabilities", () => {
    // An older Ollama, or a failed /api/show.
    const support = resolveOllamaAttachmentSupport(
      undefined,
      devMetadata({ supportsVision: true }),
    );
    expect(support.supportsVision).toBe(true);
  });

  it("assumes nothing when neither source knows anything", () => {
    const support = resolveOllamaAttachmentSupport(undefined, undefined);
    expect(support.supportsVision).toBe(false);
  });
});
