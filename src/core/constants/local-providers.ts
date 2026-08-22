import type { ProviderName } from "@/core/constants/models";

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
