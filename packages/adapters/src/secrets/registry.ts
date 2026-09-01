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
  ollama: "OLLAMA_API_KEY",
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

/** The config path holding the daemon's own bearer token. */
export const DAEMON_TOKEN_PATH = "daemon.token";

/** Environment variable that overrides the daemon token stored in the keyring. */
export const DAEMON_TOKEN_ENV_VAR = "JAZZ_DAEMON_TOKEN";

/** A peer's bearer token, e.g. `peers.sam.token`. */
const PEER_TOKEN_PATH = /^peers\.[^.]+\.token$/;

/** The config path holding one peer's token. */
export function peerTokenPath(peerName: string): string {
  return `peers.${peerName}.token`;
}

/** A webhook's bearer token, e.g. `webhooks.github-deploy.token`. */
const WEBHOOK_TOKEN_PATH = /^webhooks\.[^.]+\.token$/;

/** The config path holding one webhook's token. */
export function webhookTokenPath(webhookName: string): string {
  return `webhooks.${webhookName}.token`;
}

/**
 * Environment variable supplying a webhook's token, for hosts with no keyring.
 *
 * Same reasoning as `peerTokenEnvVar`: a container has no keyring, and this is exactly where
 * a daemon serving webhooks is likely to run.
 */
export function webhookTokenEnvVar(webhookName: string): string {
  return `JAZZ_WEBHOOK_TOKEN_${secretEnvVarSuffix(webhookName)}`;
}

function secretEnvVarSuffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Environment variable supplying a peer's token, for hosts with no keyring.
 *
 * The keyring is the right home on a workstation and simply absent in a container — which
 * is exactly where jazz already runs. The Telegram bridge takes its Telegram and search
 * credentials from the environment for this reason; without the same option here, a
 * containerised jazz could not authenticate a peer at all.
 */
export function peerTokenEnvVar(peerName: string): string {
  return `JAZZ_PEER_TOKEN_${peerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Every config path Jazz treats as a secret. */
export const SECRET_PATHS: readonly string[] = [
  ...Object.keys(SECRET_ENV_VARS),
  OTLP_AUTHORIZATION_PATH,
  DAEMON_TOKEN_PATH,
];

/**
 * Whether a config path holds a secret.
 *
 * Falls back to a shape match so provider keys Jazz does not yet know about are
 * still protected rather than silently written to disk in plaintext.
 */
export function isSecretPath(path: string): boolean {
  if (path in SECRET_ENV_VARS) return true;
  // The daemon's own bearer token authenticates operator HTTP calls the same way a peer or
  // webhook token authenticates theirs — it belongs in the keyring, not in plaintext config.
  if (path === DAEMON_TOKEN_PATH) return true;
  // A peer's bearer token authenticates this machine to somebody else's agent. It belongs
  // in the keyring for the same reason an API key does, and the config file names the peer
  // without ever holding its credential.
  if (PEER_TOKEN_PATH.test(path)) return true;
  // A webhook's bearer token authenticates an inbound caller. It belongs in the keyring for
  // the same reason a peer token does: the config file names the webhook without ever
  // holding its credential.
  if (WEBHOOK_TOKEN_PATH.test(path)) return true;
  // Every OTLP header is treated as a secret, not just `authorization`: a
  // backend may name its credential header anything, and guessing wrong writes
  // it to disk in plaintext.
  if (OTLP_HEADER_PATH.test(path)) return true;
  return /^(llm|web_search)\.[^.]+\.api_key$/.test(path);
}

/** Environment variable that supplies a secret path, if one is defined. */
export function envVarForSecretPath(path: string): string | undefined {
  if (path === DAEMON_TOKEN_PATH) return DAEMON_TOKEN_ENV_VAR;
  // Peer names are user-defined, so their variables are derived rather than enumerated.
  const peer = /^peers\.([^.]+)\.token$/.exec(path);
  if (peer?.[1] !== undefined) return peerTokenEnvVar(peer[1]);
  const webhook = /^webhooks\.([^.]+)\.token$/.exec(path);
  if (webhook?.[1] !== undefined) return webhookTokenEnvVar(webhook[1]);
  return SECRET_ENV_VARS[path];
}
