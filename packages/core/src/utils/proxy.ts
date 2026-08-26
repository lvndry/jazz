/**
 * HTTP(S) proxy support driven by the standard `HTTP_PROXY` / `HTTPS_PROXY` /
 * `NO_PROXY` environment variables.
 *
 * Every outbound request Jazz makes — provider APIs, the model catalog, the
 * update check, web fetch/search tools, remote MCP servers — goes through the
 * global `fetch`. Node's `fetch` ignores the proxy environment variables
 * entirely, so on a corporate network every one of those requests fails at
 * connect time with no hint as to why. Installing an undici global dispatcher
 * built from the same variables is what makes them take effect.
 */

export type ProxySettings = {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy?: string;
};

export type ProxyInstallResult =
  | { readonly status: "not-configured" }
  | { readonly status: "runtime-native"; readonly settings: ProxySettings }
  | { readonly status: "installed"; readonly settings: ProxySettings }
  | { readonly status: "unsupported"; readonly settings: ProxySettings; readonly reason: string }
  | { readonly status: "failed"; readonly settings: ProxySettings; readonly reason: string };

type Environment = Record<string, string | undefined>;

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Reads proxy configuration from the environment.
 *
 * Lowercase names win over uppercase ones, matching curl and undici. `ALL_PROXY`
 * fills in for whichever of the two protocols was not given its own value.
 *
 * @returns The configured settings, or `null` when no proxy is configured.
 */
export function readProxySettings(env: Environment = process.env): ProxySettings | null {
  const allProxy = firstNonEmpty(env["all_proxy"], env["ALL_PROXY"]);
  const httpProxy = firstNonEmpty(env["http_proxy"], env["HTTP_PROXY"], allProxy);
  const httpsProxy = firstNonEmpty(env["https_proxy"], env["HTTPS_PROXY"], allProxy);
  const noProxy = firstNonEmpty(env["no_proxy"], env["NO_PROXY"]);

  if (!httpProxy && !httpsProxy) {
    return null;
  }

  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
}

/**
 * Reports the first proxy URL undici cannot dial, if any.
 *
 * SOCKS proxies are the common case here: `ALL_PROXY=socks5://…` is a perfectly
 * ordinary thing to have exported, and undici has no SOCKS support, so it is
 * worth saying so rather than failing later on every request.
 *
 * @returns A human-readable reason, or `null` when every URL is usable.
 */
export function findUnsupportedProxy(settings: ProxySettings): string | null {
  for (const url of [settings.httpProxy, settings.httpsProxy]) {
    if (!url) {
      continue;
    }

    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return `"${url}" is not a valid URL`;
    }

    if (!SUPPORTED_PROXY_PROTOCOLS.has(protocol)) {
      return `"${protocol}//" proxies are not supported — use an http:// or https:// proxy`;
    }
  }

  return null;
}

/**
 * Routes global `fetch` through the proxy named in the environment.
 *
 * Call this before anything issues a request. Bun's `fetch` already honours the
 * same variables natively, so there it only reports what the runtime is doing.
 */
export async function installProxyFromEnvironment(
  env: Environment = process.env,
): Promise<ProxyInstallResult> {
  const settings = readProxySettings(env);
  if (!settings) {
    return { status: "not-configured" };
  }

  const unsupported = findUnsupportedProxy(settings);
  if (unsupported) {
    return { status: "unsupported", settings, reason: unsupported };
  }

  if (isBunRuntime()) {
    return { status: "runtime-native", settings };
  }

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent(settings));
    return { status: "installed", settings };
  } catch (error) {
    return {
      status: "failed",
      settings,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Installs proxy support and writes a warning to stderr if it could not be done.
 *
 * Staying quiet on success keeps normal runs clean; staying quiet on failure is
 * what produces the unexplained connection errors this module exists to avoid.
 */
export async function installProxyFromEnvironmentAndWarn(
  env: Environment = process.env,
): Promise<ProxyInstallResult> {
  const result = await installProxyFromEnvironment(env);

  if (result.status === "unsupported" || result.status === "failed") {
    console.error(`Jazz: proxy environment variables are set but unusable — ${result.reason}.`);
    console.error("Jazz: continuing with direct connections, which will fail behind a proxy.");
  }

  return result;
}

function isBunRuntime(): boolean {
  return typeof process.versions["bun"] === "string";
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}
