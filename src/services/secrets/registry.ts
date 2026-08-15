/**
 * Single source of truth for which config paths hold secrets, and which
 * environment variable supplies each one.
 *
 * Every secret in Jazz is reachable at a dot-notation config path. Centralising
 * the list here means the config service can resolve, redact, and relocate
 * secrets without each call site knowing it is handling one.
 */

/** Keychain/libsecret service name under which Jazz stores its secrets. */
export const KEYRING_SERVICE_NAME = "jazz";

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
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  togetherai: "TOGETHER_AI_API_KEY",
  xai: "XAI_API_KEY",
  zhipuai: "ZHIPU_API_KEY",
};

const WEB_SEARCH_PROVIDER_ENV_VARS: Record<string, string> = {
  brave: "BRAVE_API_KEY",
  exa: "EXA_API_KEY",
  linkup: "LINKUP_API_KEY",
  parallel: "PARALLEL_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  tavily: "TAVILY_API_KEY",
};

function buildSecretEnvVars(): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const [provider, envVar] of Object.entries(LLM_PROVIDER_ENV_VARS)) {
    paths[`llm.${provider}.api_key`] = envVar;
  }
  for (const [provider, envVar] of Object.entries(WEB_SEARCH_PROVIDER_ENV_VARS)) {
    paths[`web_search.${provider}.api_key`] = envVar;
  }
  return paths;
}

/** Config path -> environment variable name, for every known secret. */
export const SECRET_ENV_VARS: Record<string, string> = buildSecretEnvVars();

/**
 * Headers sent to the OTLP export endpoint.
 *
 * These carry the collector's credential — a Langfuse key pair, a vendor API
 * token — so they are secrets even though they are not `api_key` shaped. There
 * is no per-header env var: `OTEL_EXPORTER_OTLP_HEADERS` supplies the whole set
 * at once and is read by the telemetry layer, not resolved per path here.
 */
const OTLP_HEADER_PATH = /^telemetry\.otlp\.headers\.[^.]+$/;

/** The header operators actually set; listed so the keyring is checked for it on load. */
export const OTLP_AUTHORIZATION_PATH = "telemetry.otlp.headers.authorization";

/** Every config path Jazz treats as a secret. */
export const SECRET_PATHS: readonly string[] = [
  ...Object.keys(SECRET_ENV_VARS),
  OTLP_AUTHORIZATION_PATH,
];

/**
 * Whether a config path holds a secret.
 *
 * Falls back to a shape match so provider keys Jazz does not yet know about are
 * still protected rather than silently written to disk in plaintext.
 */
export function isSecretPath(path: string): boolean {
  if (path in SECRET_ENV_VARS) return true;
  // Every OTLP header is treated as a secret, not just `authorization`: a
  // backend may name its credential header anything, and guessing wrong writes
  // it to disk in plaintext.
  if (OTLP_HEADER_PATH.test(path)) return true;
  return /^(llm|web_search)\.[^.]+\.api_key$/.test(path);
}

/** Environment variable that supplies a secret path, if one is defined. */
export function envVarForSecretPath(path: string): string | undefined {
  return SECRET_ENV_VARS[path];
}
