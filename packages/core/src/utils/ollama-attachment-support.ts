import type { ModelsDevMetadata } from "@/core/utils/models-dev";

/**
 * Attachment modalities for a local Ollama model, from `/api/show` `capabilities`.
 *
 * Local models are largely absent from models.dev, so without this a genuinely multimodal
 * local model (`gemma4:12b` reports `vision` *and* `audio`) would be treated as text-only and
 * jazz would refuse to send it an image it can perfectly well read. Ollama describes the model
 * file actually on the host, so it outranks the catalog.
 *
 * Ollama has no `video` capability tag, so video is never inferred here — a local model that
 * genuinely accepts video would need the catalog to say so.
 */
export function resolveOllamaAttachmentSupport(
  capabilities: readonly string[] | undefined,
  dev: ModelsDevMetadata | undefined,
): { ingestImage: boolean; ingestPdf: boolean; ingestAudio: boolean } {
  if (capabilities !== undefined) {
    return {
      ingestImage: capabilities.includes("vision"),
      // Not `capabilities.includes("audio")`: see the transport note above.
      ingestAudio: false,
      ingestPdf: false,
    };
  }
  // No capabilities reported (older Ollama, or /api/show failed). The catalog is the only
  // remaining signal, still narrowed to what the provider can actually transport.
  return {
    ingestImage: dev?.ingestImage ?? false,
    ingestPdf: false,
    ingestAudio: false,
  };
}
