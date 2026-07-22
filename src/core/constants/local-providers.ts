import type { ProviderName } from "@/core/constants/models";

/**
 * Local providers Jazz talks to over a user-managed HTTP server. A connection
 * failure against these usually means the server simply is not running, so the
 * metadata here (display name, default URL, start hint) drives the actionable
 * "server unreachable" diagnostics.
 */
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
