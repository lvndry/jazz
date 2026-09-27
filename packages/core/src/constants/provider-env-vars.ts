/**
 * Which environment variables supply each LLM provider's API key.
 *
 * Lives in core so every layer names the same variables: the config service
 * resolves keys from them (`core/secrets/registry` re-exports this table),
 * the first-run wizard reports which ones are set, and error hints tell people
 * which one to export.
 */

/**
 * Env var names for LLM provider API keys, keyed by provider name.
 * Exported separately because the LLM service also resolves providers from a
 * raw LLMConfig that never passed through the config service.
 */
export const LLM_PROVIDER_ENV_VARS: Record<string, string> = {
  ai_gateway: "AI_GATEWAY_API_KEY",
  alibaba: "ALIBABA_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  llamacpp: "LLAMACPP_API_KEY",
  minimax: "MINIMAX_API_KEY",
  mistral: "MISTRAL_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  ollama: "OLLAMA_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  orcarouter: "ORCAROUTER_API_KEY",
  sglang: "SGLANG_API_KEY",
  togetherai: "TOGETHER_AI_API_KEY",
  vllm: "VLLM_API_KEY",
  xai: "XAI_API_KEY",
  zhipuai: "ZHIPU_API_KEY",
};

/**
 * Extra environment variables accepted for a provider's key, tried after the canonical one.
 *
 * `GOOGLE_GENERATIVE_AI_API_KEY` stays canonical because it is what the AI SDK's Google
 * provider reads when jazz passes no explicit key. But Google's own docs, its CLI, and most
 * other tooling use `GEMINI_API_KEY`, so somebody who exports that has done nothing wrong and
 * should not have to discover a second name for the same secret.
 *
 * `NVIDIA_API_KEY` is what NVIDIA's own docs use; `NIM_API_KEY` is what the AI SDK's NIM
 * guide exports.
 */
export const LLM_PROVIDER_ENV_VAR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  gemini: ["GEMINI_API_KEY"],
  nvidia: ["NIM_API_KEY"],
};

/** Every environment variable that can supply this provider's key, canonical first. */
export function llmProviderEnvVars(provider: string): readonly string[] {
  const canonical = LLM_PROVIDER_ENV_VARS[provider];
  const aliases = LLM_PROVIDER_ENV_VAR_ALIASES[provider] ?? [];
  return canonical === undefined ? aliases : [canonical, ...aliases];
}

/**
 * How to give Jazz a provider's API key, for error messages and hints:
 * `jazz config set <provider>` prompts for the key, so it never lands in shell
 * history, and the environment variable works without saving anything.
 */
export function apiKeyHint(provider: string): string {
  const envVar = llmProviderEnvVars(provider)[0];
  const prompt = `run \`jazz config set ${provider}\` and paste the key when asked`;
  return envVar === undefined
    ? `To set it, ${prompt}.`
    : `To set it, ${prompt}, or export ${envVar}.`;
}
