export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly isReasoningModel?: boolean;
}

export type ModelSource =
  | { type: "static"; models: readonly ModelInfo[] }
  | { type: "dynamic"; endpointPath: string; defaultBaseUrl?: string };

export const PROVIDER_MODELS = {
  openai: {
    type: "static",
    models: [
      { id: "gpt-5.1", displayName: "GPT-5.1", isReasoningModel: true },
      { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", isReasoningModel: true },
      { id: "gpt-5", displayName: "GPT-5", isReasoningModel: true },
      { id: "gpt-5-pro", displayName: "GPT-5 Pro", isReasoningModel: true },
      { id: "gpt-5-codex", displayName: "GPT-5 Codex", isReasoningModel: true },
      { id: "gpt-5-mini", displayName: "GPT-5 Mini", isReasoningModel: true },
      { id: "gpt-5-nano", displayName: "GPT-5 Nano", isReasoningModel: true },
      { id: "gpt-4.1", displayName: "GPT-4.1", isReasoningModel: true },
      { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini", isReasoningModel: true },
      { id: "gpt-4.1-nano", displayName: "GPT-4.1 Nano", isReasoningModel: true },
      { id: "gpt-4o", displayName: "GPT-4o", isReasoningModel: false },
      { id: "gpt-4o-mini", displayName: "GPT-4o Mini", isReasoningModel: false },
      { id: "o4-mini", displayName: "o4-mini", isReasoningModel: true },
    ],
  },
  anthropic: {
    type: "static",
    models: [
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", isReasoningModel: true },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", isReasoningModel: true },
      { id: "claude-opus-4-1", displayName: "Claude Opus 4.1", isReasoningModel: true },
    ],
  },
  google: {
    type: "static",
    models: [
      { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", isReasoningModel: true },
      { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", isReasoningModel: true },
      {
        id: "gemini-2.5-flash-lite",
        displayName: "Gemini 2.5 Flash Lite",
        isReasoningModel: true,
      },
      { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", isReasoningModel: false },
    ],
  },
  mistral: {
    type: "static",
    models: [
      { id: "mistral-large-latest", displayName: "Mistral Large", isReasoningModel: false },
      { id: "mistral-medium-latest", displayName: "Mistral Medium", isReasoningModel: false },
      { id: "mistral-small-latest", displayName: "Mistral Small", isReasoningModel: false },
      { id: "magistral-medium-2506", displayName: "Magistral Medium", isReasoningModel: true },
      { id: "magistral-small-2506", displayName: "Magistral Small", isReasoningModel: true },
    ],
  },
  xai: {
    type: "static",
    models: [
      {
        id: "grok-4-fast-non-reasoning",
        displayName: "Grok 4 Fast (Non-Reasoning)",
        isReasoningModel: false,
      },
      {
        id: "grok-4-fast-reasoning",
        displayName: "Grok 4 Fast (Reasoning)",
        isReasoningModel: true,
      },
      { id: "grok-4", displayName: "Grok 4", isReasoningModel: false },
      { id: "grok-code-fast-1", displayName: "Grok 4 (0709)", isReasoningModel: true },
      { id: "grok-3", displayName: "Grok 3", isReasoningModel: true },
      { id: "grok-3-mini", displayName: "Grok 3 Mini", isReasoningModel: true },
    ],
  },
  deepseek: {
    type: "static",
    models: [{ id: "deepseek-chat", displayName: "DeepSeek Chat", isReasoningModel: false }],
  },
  ollama: {
    type: "dynamic",
    endpointPath: "/tags",
    defaultBaseUrl: "http://localhost:11434/api",
  },
  openrouter: {
    type: "dynamic",
    endpointPath: "/api/v1/models",
    defaultBaseUrl: "https://openrouter.ai",
  },
} as const satisfies Record<string, ModelSource>;

export type ProviderName = keyof typeof PROVIDER_MODELS;
export const AVAILABLE_PROVIDERS = Object.keys(PROVIDER_MODELS) as ProviderName[];
