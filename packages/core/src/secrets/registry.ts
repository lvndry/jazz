/**
 * Single source of truth for which config paths hold secrets, and which
 * environment variable supplies each one.
 *
 * Every secret in Jazz is reachable at a dot-notation config path. Centralising
 * the list here means the config service can resolve, redact, and relocate
 * secrets without each call site knowing it is handling one.
 */

import {
  LLM_PROVIDER_ENV_VAR_ALIASES,
  LLM_PROVIDER_ENV_VARS,
  llmProviderEnvVars,
} from "@/core/constants/provider-env-vars";
import { isSecretName, mentionsSecret, redactionPlaceholder } from "@/core/secrets/secret-names";
import { NOTIFY_TARGET_SECRET_FIELDS } from "@/core/types/notify";
import { secretEnvVarSuffix } from "@/core/utils/secret-env-var";

export { LLM_PROVIDER_ENV_VAR_ALIASES, LLM_PROVIDER_ENV_VARS, llmProviderEnvVars };

const WEB_SEARCH_PROVIDER_ENV_VARS: Record<string, string> = {
  brave: "BRAVE_API_KEY",
  exa: "EXA_API_KEY",
  linkup: "LINKUP_API_KEY",
  parallel: "PARALLEL_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  tavily: "TAVILY_API_KEY",
};

/** This provider's key from the environment, canonical variable first, or undefined. */
export function llmProviderApiKeyFromEnv(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of llmProviderEnvVars(provider)) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

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

/**
 * The keyring entry holding the daemon's operator token, which HTTP policy grants need on top of
 * the daemon token. It has no environment variable and no file fallback, and it is left out of
 * {@link SECRET_PATHS} so it is never loaded into the app config; see `packages/daemon/src/operator-token.ts`.
 */
export const DAEMON_OPERATOR_TOKEN_PATH = "daemon.operatorToken";

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

/** A webhook's signing secret, e.g. `webhooks.github-deploy.secret`. */
const WEBHOOK_SECRET_PATH = /^webhooks\.[^.]+\.secret$/;

/** The config path holding the secret one webhook's sender signs its bodies with. */
export function webhookSecretPath(webhookName: string): string {
  return `webhooks.${webhookName}.secret`;
}

/** Environment variable supplying a webhook's signing secret, for hosts with no keyring. */
export function webhookSecretEnvVar(webhookName: string): string {
  return `JAZZ_WEBHOOK_SECRET_${secretEnvVarSuffix(webhookName)}`;
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

/**
 * Environment variable supplying a peer's token, for hosts with no keyring.
 *
 * The keyring is the right home on a workstation and simply absent in a container — which
 * is exactly where jazz already runs. The Telegram bridge takes its Telegram and search
 * credentials from the environment for this reason; without the same option here, a
 * containerised jazz could not authenticate a peer at all.
 */
export function peerTokenEnvVar(peerName: string): string {
  return `JAZZ_PEER_TOKEN_${secretEnvVarSuffix(peerName)}`;
}

/** Every field name any notify target kind keeps in the keyring. */
const NOTIFY_SECRET_FIELD_NAMES: readonly string[] = [
  ...new Set(Object.values(NOTIFY_TARGET_SECRET_FIELDS).flat()),
];

/** A notify target's secret field, e.g. `notify.targets.phone.botToken`. */
const NOTIFY_TARGET_SECRET_PATH = new RegExp(
  `^notify\\.targets\\.([^.]+)\\.(${NOTIFY_SECRET_FIELD_NAMES.join("|")})$`,
);

/** A notify secret field as it ends its environment variable: `botToken` gives `BOT_TOKEN`. */
function notifyFieldEnvSuffix(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

/** The config path holding one notify target's secret field. */
export function notifyTargetSecretPath(target: string, field: string): string {
  return `notify.targets.${target}.${field}`;
}

/**
 * Environment variable supplying a notify target's secret, for hosts with no keyring:
 * `JAZZ_NOTIFY_PHONE_BOT_TOKEN` for `notify.targets.phone.botToken`.
 */
export function notifyTargetSecretEnvVar(target: string, field: string): string {
  return `JAZZ_NOTIFY_${secretEnvVarSuffix(target)}_${notifyFieldEnvSuffix(field)}`;
}

/** The two maps in an MCP server definition whose values are handed to the server. */
export type McpServerSecretField = "env" | "headers";

/** An MCP server's env var or HTTP header value, e.g. `mcpServers.signoz.env.SIGNOZ_API_KEY`. */
const MCP_SERVER_SECRET_PATH = /^mcpServers\..+\.(env|headers)\..+$/;

/** Whether `path` is an MCP server's env var or HTTP header value. */
export function isMcpServerSecretPath(path: string): boolean {
  return MCP_SERVER_SECRET_PATH.test(path);
}

/**
 * The keyring account holding one env var or header value of an MCP server defined in the
 * user's `~/.agents/mcp.json`. The file keeps the key with an empty value.
 */
export function mcpServerSecretPath(
  serverName: string,
  field: McpServerSecretField,
  key: string,
): string {
  return `mcpServers.${serverName}.${field}.${key}`;
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
  if (path === DAEMON_OPERATOR_TOKEN_PATH) {
    return true;
  }
  // A peer's bearer token authenticates this machine to somebody else's agent. It belongs
  // in the keyring for the same reason an API key does, and the config file names the peer
  // without ever holding its credential.
  if (PEER_TOKEN_PATH.test(path)) return true;
  // A webhook's bearer token authenticates an inbound caller. It belongs in the keyring for
  // the same reason a peer token does: the config file names the webhook without ever
  // holding its credential.
  if (WEBHOOK_TOKEN_PATH.test(path)) return true;
  // A notify target's bot token, token-bearing webhook URL or signing key authenticates Jazz
  // to your chat or endpoint; the config file names the target without holding them.
  if (NOTIFY_TARGET_SECRET_PATH.test(path)) return true;
  if (WEBHOOK_SECRET_PATH.test(path)) {
    return true;
  }
  // Every OTLP header is treated as a secret, not just `authorization`: a
  // backend may name its credential header anything, and guessing wrong writes
  // it to disk in plaintext.
  if (OTLP_HEADER_PATH.test(path)) return true;
  // Every MCP env var and header is treated as a secret: `--env` and `--header` carry API keys
  // and bearer tokens under whatever name the server chose.
  if (isMcpServerSecretPath(path)) return true;
  return /^(llm|web_search)\.[^.]+\.api_key$/.test(path);
}

/**
 * The value for a secret path from the environment, honouring provider aliases.
 *
 * `envVarForSecretPath` names one variable, which is right for a message telling somebody what
 * to set. Resolution needs every accepted name, which is what this returns.
 */
export function secretValueFromEnv(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const llm = /^llm\.([^.]+)\.api_key$/.exec(path);
  if (llm?.[1] !== undefined) return llmProviderApiKeyFromEnv(llm[1], env);
  const envVar = envVarForSecretPath(path);
  return envVar === undefined ? undefined : env[envVar];
}

/** Environment variable that supplies a secret path, if one is defined. */
export function envVarForSecretPath(path: string): string | undefined {
  if (path === DAEMON_TOKEN_PATH) return DAEMON_TOKEN_ENV_VAR;
  // Peer names are user-defined, so their variables are derived rather than enumerated.
  const peer = /^peers\.([^.]+)\.token$/.exec(path);
  if (peer?.[1] !== undefined) return peerTokenEnvVar(peer[1]);
  const webhook = /^webhooks\.([^.]+)\.token$/.exec(path);
  if (webhook?.[1] !== undefined) return webhookTokenEnvVar(webhook[1]);
  const target = NOTIFY_TARGET_SECRET_PATH.exec(path);
  if (target?.[1] !== undefined && target[2] !== undefined) {
    return notifyTargetSecretEnvVar(target[1], target[2]);
  }
  const webhookSecret = /^webhooks\.([^.]+)\.secret$/.exec(path);
  if (webhookSecret?.[1] !== undefined) {
    return webhookSecretEnvVar(webhookSecret[1]);
  }
  return SECRET_ENV_VARS[path];
}

export function redactSecretValues(value: unknown, prefix = ""): unknown {
  if (typeof value === "string") {
    return value !== "" && prefix !== "" && isSecretPath(prefix)
      ? redactionPlaceholder(prefix)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactSecretValues(item, joinPath(prefix, String(index))));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactSecretValues(nested, joinPath(prefix, key)),
      ]),
    );
  }
  return value;
}

function joinPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

/** Every environment variable name a registered secret path reads, provider aliases included. */
const REGISTERED_SECRET_ENV_VARS: ReadonlySet<string> = new Set([
  ...Object.values(SECRET_ENV_VARS),
  ...Object.values(LLM_PROVIDER_ENV_VAR_ALIASES).flat(),
  DAEMON_TOKEN_ENV_VAR,
]);

/** `JAZZ_PEER_TOKEN_<NAME>`, `JAZZ_WEBHOOK_TOKEN_<NAME>`, `JAZZ_WEBHOOK_SECRET_<NAME>`. */
const DOOR_SECRET_ENV_VAR = /^JAZZ_(?:PEER_TOKEN|WEBHOOK_TOKEN|WEBHOOK_SECRET)_[A-Z0-9_]+$/;

/** `JAZZ_NOTIFY_<TARGET>_<FIELD>` for every notify secret field, e.g. `..._WEBHOOK_URL`. */
const NOTIFY_SECRET_ENV_VAR = new RegExp(
  `^JAZZ_NOTIFY_[A-Z0-9_]+_(?:${NOTIFY_SECRET_FIELD_NAMES.map(notifyFieldEnvSuffix).join("|")})$`,
);

/** Whether `name` is an environment variable Jazz reads a secret from. */
function isJazzSecretEnvVar(name: string): boolean {
  return (
    REGISTERED_SECRET_ENV_VARS.has(name) ||
    DOOR_SECRET_ENV_VAR.test(name) ||
    NOTIFY_SECRET_ENV_VAR.test(name)
  );
}

/**
 * Whether the environment variable `name` holds a secret value: a secret-named variable
 * (`OPENAI_API_KEY`, `APP_KEY`, `DB_PASS`) or one Jazz reads a secret from, such as
 * `JAZZ_NOTIFY_OPS_WEBHOOK_URL`.
 */
export function isSecretEnvVarName(name: string): boolean {
  return isSecretName(name) || isJazzSecretEnvVar(name);
}

/**
 * Whether the environment variable `name` is withheld from a child process: everything
 * {@link isSecretEnvVarName} accepts, and any name with a secret word anywhere in it
 * (`GITHUB_TOKEN_FILE`, `AUTH_HEADER_JSON`).
 */
export function isWithheldEnvVarName(name: string): boolean {
  return mentionsSecret(name) || isJazzSecretEnvVar(name);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(value)?.[key]);
}

function namedEntries(value: unknown): { name: string; entry: Record<string, unknown> }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return typeof record["name"] === "string" ? [{ name: record["name"], entry: record }] : [];
  });
}

/**
 * The secret paths whose values the runtime config holds: every `llm` and `web_search` provider
 * key the config names, and every OTLP export header, by whatever name the backend uses.
 */
export function runtimeSecretPaths(config: unknown): string[] {
  const paths: string[] = [];
  for (const section of ["llm", "web_search"]) {
    for (const [provider, providerConfig] of Object.entries(recordAt(config, section) ?? {})) {
      if (typeof asRecord(providerConfig)?.["api_key"] === "string") {
        paths.push(`${section}.${provider}.api_key`);
      }
    }
  }
  const headers = recordAt(recordAt(recordAt(config, "telemetry"), "otlp"), "headers");
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      paths.push(`telemetry.otlp.headers.${name}`);
    }
  }
  return paths;
}

/**
 * Every secret path Jazz may hold a value for under `config`, outside MCP server definitions:
 * {@link SECRET_PATHS}, the daemon's operator token, the runtime paths, each peer's token, each
 * webhook's token and signing secret, and each notify target's secret fields. MCP env var and
 * header values are resolved into the runtime config itself when it loads.
 */
export function heldSecretPaths(config: unknown): string[] {
  const paths = new Set<string>([
    ...SECRET_PATHS,
    DAEMON_OPERATOR_TOKEN_PATH,
    ...runtimeSecretPaths(config),
  ]);
  const record = asRecord(config) ?? {};
  for (const { name } of namedEntries(record["peers"])) {
    paths.add(peerTokenPath(name));
  }
  for (const { name } of namedEntries(record["webhooks"])) {
    paths.add(webhookTokenPath(name));
    paths.add(webhookSecretPath(name));
  }
  for (const { name, entry } of namedEntries(recordAt(record, "notify")?.["targets"])) {
    const kind = entry["kind"];
    const fields =
      typeof kind === "string" && kind in NOTIFY_TARGET_SECRET_FIELDS
        ? NOTIFY_TARGET_SECRET_FIELDS[kind as keyof typeof NOTIFY_TARGET_SECRET_FIELDS]
        : [];
    for (const field of fields) {
      paths.add(notifyTargetSecretPath(name, field));
    }
  }
  return [...paths].filter(isSecretPath);
}
