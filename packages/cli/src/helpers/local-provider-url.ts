/**
 * First-use configuration for local model servers.
 *
 * Agent creation needs a reachable base URL before it asks the LLM service to discover models.
 * This helper keeps that prompt consistent for Ollama, llama.cpp, and vLLM, persists the normalized URL,
 * and leaves already-configured or environment-configured servers alone.
 */

import { normalizeLocalProviderBaseUrl } from "@jazz/adapters/llm/models";
import {
  LOCAL_SERVER_PROVIDERS,
  localServerAddress,
  type LocalServerProvider,
} from "@jazz/core/constants/local-providers";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { formatProviderDisplayName } from "@jazz/core/utils/provider-model";
import { Effect } from "effect";

export type LocalProviderUrlPromptResult = "saved" | "already-set" | "cancelled";

export function isValidServerAddress(input: string): boolean | string {
  const value = input.trim();
  if (value.length === 0) return true;

  try {
    const url = new URL(/:\/\//.test(value) ? value : `http://${value}`);
    return url.hostname.length > 0 || "Enter a valid host:port or URL.";
  } catch {
    return "Enter a valid host:port or URL.";
  }
}

/**
 * Ask for and persist a local provider's server URL.
 *
 * Without `force` this only prompts when no URL is configured yet. With `force` it re-prompts
 * even over a saved URL, so a caller can recover after the saved server turned out unreachable.
 * An env-var URL overrides config, so it is never prompted over: re-saving config would change
 * nothing.
 *
 * The visible default intentionally omits the provider REST path: users think in terms of the
 * server address, while normalization adds `/api` for Ollama and `/v1` for llama.cpp and vLLM. The default
 * is a placeholder rather than prefilled text so typing replaces it instead of appending to it; an
 * empty submission means that placeholder, and an Escape returns to provider selection.
 */
export async function ensureLocalProviderBaseUrl(options: {
  readonly configService: AgentConfigService;
  readonly terminal: TerminalService;
  readonly provider: LocalServerProvider;
  readonly force?: boolean;
}): Promise<LocalProviderUrlPromptResult> {
  const config = await Effect.runPromise(options.configService.appConfig);
  const configuredUrl = config.llm?.[options.provider]?.base_url?.trim();
  const envUrl = process.env[LOCAL_SERVER_PROVIDERS[options.provider].envVar]?.trim();

  if (envUrl || (configuredUrl && !options.force)) {
    return "already-set";
  }

  const providerDisplayName = formatProviderDisplayName(options.provider);
  const defaultUrl = localServerAddress(
    configuredUrl || LOCAL_SERVER_PROVIDERS[options.provider].defaultUrl,
  );
  const address = await Effect.runPromise(
    options.terminal.ask(
      `${providerDisplayName} server URL (host:port or full URL; default ${defaultUrl}):`,
      {
        validate: isValidServerAddress,
        cancellable: true,
        simple: true,
        placeholder: defaultUrl,
      },
    ),
  );

  if (address === undefined) {
    return "cancelled";
  }

  const normalized = normalizeLocalProviderBaseUrl(options.provider, address.trim() || defaultUrl);
  await Effect.runPromise(
    options.configService.set(`llm.${options.provider}.base_url`, normalized),
  );
  await Effect.runPromise(
    options.terminal.success(
      `${providerDisplayName} server set to ${localServerAddress(normalized)}.`,
    ),
  );
  return "saved";
}
