/**
 * @fileoverview The environment an agent run started by a bridge inherits.
 *
 * A bridge process holds credentials that are its own and never the agent's: the bot token
 * that lets anyone holding it read and send as the bot, a webhook secret, WhatsApp or Photon
 * credentials, the daemon token. The agent runs `execute_command`, so whatever is in its
 * environment is one `env` away from the chat, and from there a member of an allowlisted group
 * owns the bot. Passing the whole bridge environment also defeats the per-conversation uid
 * sandbox: the kernel keeps one conversation's files from another, and the environment hands
 * both the same keys regardless.
 *
 * So a child gets an allowlist, never a copy: what a process needs to run at all (PATH, locale,
 * time zone, proxies), what Jazz itself reads to reach a model or a search provider, and Jazz's
 * own runtime switches. Everything else is dropped by default, which is the direction a new
 * bridge secret should fail in.
 *
 * Provider keys stay shared: every conversation on a bridge bills the operator's accounts.
 */

import { LLM_PROVIDER_ENV_VAR_ALIASES, SECRET_ENV_VARS } from "@jazz/adapters/secrets/registry";
import { LOCAL_SERVER_PROVIDERS } from "@jazz/core/constants/local-providers";

/** What any process needs to start, find binaries, and format text for a person. */
const PROCESS_VARIABLES = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "TZ",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "GNUPGHOME",
  "PASSWORD_STORE_DIR",
  "PUPPETEER_EXECUTABLE_PATH",
] as const;

/** Outbound proxies, in both spellings tools read. Without them a proxied host has no network. */
const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
] as const;

/** Jazz's own runtime switches. Tokens (daemon, peers, webhooks) are deliberately absent. */
const JAZZ_RUNTIME_VARIABLES = [
  "JAZZ_NO_TUI",
  "JAZZ_DISABLE_UPDATE_CHECK",
  "JAZZ_DISABLE_KEYRING",
  "JAZZ_DISABLE_CATCH_UP",
  "JAZZ_OFFLINE",
  "JAZZ_LOG_DIR",
  "JAZZ_MODELS_DEV_URL",
  "JAZZ_LIBRARY_URL",
  "JAZZ_PLUGIN_CATALOG_URL",
  "JAZZ_STREAM_IDLE_TIMEOUT_MS",
  "JAZZ_WEB_MODE",
  "JAZZ_OUTPUT_MODE",
] as const;

/** Where a model's telemetry goes; the run reports to the same collector the operator set. */
const TELEMETRY_VARIABLES = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
] as const;

/** What an interactive shell into a sandbox needs on top, and an agent run does not. */
const TERMINAL_VARIABLES = ["TERM", "COLORTERM"] as const;

/** Model and search provider credentials and endpoints, read from the one registry Jazz uses. */
function providerVariables(): readonly string[] {
  return [
    ...Object.values(SECRET_ENV_VARS),
    ...Object.values(LLM_PROVIDER_ENV_VAR_ALIASES).flat(),
    ...Object.values(LOCAL_SERVER_PROVIDERS).map((provider) => provider.envVar),
    "ANTHROPIC_WORKSPACE_ID",
  ];
}

/** Locale categories (`LC_ALL`, `LC_CTYPE`, …) are a family, not a fixed list. */
const LOCALE_CATEGORY = /^LC_[A-Z]+$/;

let allowedNames: ReadonlySet<string> | undefined;

function childVariableNames(): ReadonlySet<string> {
  allowedNames ??= new Set<string>([
    ...PROCESS_VARIABLES,
    ...PROXY_VARIABLES,
    ...JAZZ_RUNTIME_VARIABLES,
    ...TELEMETRY_VARIABLES,
    ...providerVariables(),
  ]);
  return allowedNames;
}

export interface ChildEnvOptions {
  /** Keep the terminal description, for a person dropped into a shell inside a sandbox. */
  readonly interactiveTerminal?: boolean;
}

/**
 * The subset of `base` a bridge may hand to a child it starts.
 *
 * Unset and empty variables are left out so a child's own defaults apply.
 */
export function childEnvironment(
  base: NodeJS.ProcessEnv,
  options: ChildEnvOptions = {},
): Record<string, string> {
  const allowed = childVariableNames();
  const terminal: ReadonlySet<string> = new Set(
    options.interactiveTerminal === true ? TERMINAL_VARIABLES : [],
  );
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || value.length === 0) {
      continue;
    }
    if (allowed.has(name) || terminal.has(name) || LOCALE_CATEGORY.test(name)) {
      environment[name] = value;
    }
  }
  return environment;
}
