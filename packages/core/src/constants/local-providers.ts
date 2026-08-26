/**
 * Metadata and helpers for providers that serve models from the user's own
 * machine (Ollama, llama.cpp), used for unreachable-server diagnostics and
 * zero-cost detection.
 */
import type { ProviderName } from "@/core/constants/models";
import { isOllamaCloudModel } from "@/core/constants/ollama";

// Local, user-run servers. This metadata drives the "server unreachable" diagnostics.
export const LOCAL_SERVER_PROVIDERS = {
  llamacpp: {
    name: "llama.cpp",
    defaultUrl: "http://localhost:8080",
    startHint: "llama-server -m <model>.gguf --port 8080 --jinja",
  },
  ollama: {
    name: "Ollama",
    defaultUrl: "http://localhost:11434",
    startHint: "ollama serve",
  },
} as const satisfies Partial<Record<ProviderName, unknown>>;

/**
 * Whether this provider serves models from the user's own machine.
 *
 * Several behaviours hinge on this beyond the unreachable-server diagnostics: local models get
 * their context window from the running server rather than the catalog, and attachment size
 * limits are relaxed for them because every one of those limits is really a remote API's
 * request cap.
 */
export function isLocalServerProvider(provider: string): boolean {
  return provider in LOCAL_SERVER_PROVIDERS;
}

/**
 * Whether a run on this model genuinely costs nothing when no pricing metadata
 * exists. Ollama models with a cloud tag bill remotely despite the local
 * provider name, so they are excluded.
 */
export function isZeroCostLocalModel(provider: string, modelId: string): boolean {
  if (!isLocalServerProvider(provider)) return false;
  return provider !== "ollama" || !isOllamaCloudModel(modelId);
}
