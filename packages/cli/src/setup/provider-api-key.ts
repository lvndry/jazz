/**
 * Interactive provider credential setup. Prompt, trim and check keys before saving them,
 * retry invalid credentials, and explain permission-limited checks without blocking setup.
 * ChatGPT credentials use the subscription sign-in flow instead of an API key prompt.
 * Call ensureProviderApiKey from a provider picker with its terminal/config services
 * and provider metadata; it reports whether setup saved, reused, skipped or cancelled
 * credentials. checkKey can replace the provider check in tests or specialized callers.
 */
import { checkApiKey, type ApiKeyCheck } from "@jazz/adapters/llm/api-key-check";
import { describeKeyringBackend, detectKeyringBackend } from "@jazz/adapters/secrets/keyring";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import type { AppConfig } from "@jazz/core/types/config";
import { isRecord } from "@jazz/core/utils/is-record";
import { Effect } from "effect";
import { configuredProviderNames } from "@/cli/ui/models/configured-providers";
import { signInToChatGPT } from "./chatgpt-sign-in";

/** Whether the provider is pointed at its own endpoint, where the stock key check does not apply. */
function hasCustomBaseUrl(config: AppConfig, provider: string): boolean {
  const providerConfig: unknown = (config.llm as Record<string, unknown> | undefined)?.[provider];
  return isRecord(providerConfig) && typeof providerConfig["base_url"] === "string";
}

export type ProviderApiKeyPromptResult = "saved" | "already-set" | "skipped" | "cancelled";

/**
 * Prompt for a provider API key when none is configured (config, keyring, or env).
 * `force` prompts even over a configured key, for when the provider rejected it.
 * Empty input is never persisted: `has()` would report a key that chat then sent
 * as a blank Bearer token. A pasted key is trimmed and checked with the provider
 * (see `checkApiKey`); one the provider rejects is asked for again instead of
 * saved.
 * ChatGPT has no API key; it runs the subscription sign-in instead.
 */
export async function ensureProviderApiKey(options: {
  readonly configService: AgentConfigService;
  readonly terminal: TerminalService;
  readonly provider: string;
  readonly displayName: string;
  readonly required: boolean;
  readonly reason?: string;
  readonly force?: boolean;
  /** Asks the provider whether it accepts a key; `checkApiKey` by default. */
  readonly checkKey?: (provider: string, apiKey: string) => Promise<ApiKeyCheck>;
}): Promise<ProviderApiKeyPromptResult> {
  const config = await Effect.runPromise(options.configService.appConfig);
  if (!options.force && configuredProviderNames(config).includes(options.provider)) {
    return "already-set";
  }

  if (options.provider === "chatgpt") {
    if (options.reason) {
      await Effect.runPromise(options.terminal.warn(options.reason));
    }
    const signedIn = await Effect.runPromise(
      signInToChatGPT(options.terminal, options.configService),
    );
    return signedIn ? "saved" : "cancelled";
  }

  if (options.reason) {
    await Effect.runPromise(options.terminal.warn(options.reason));
  }
  const backend = await Effect.runPromise(detectKeyringBackend());
  const storedIn =
    backend === "none" || backend === "file"
      ? "Stored in your Jazz config, readable only by you."
      : `Stored in ${describeKeyringBackend(backend)}, never in a config file.`;

  const hasCustomEndpoint = hasCustomBaseUrl(config, options.provider);
  const check = options.checkKey ?? checkApiKey;

  while (true) {
    const answer = await Effect.runPromise(
      options.terminal.ask(
        `Paste your ${options.displayName} API key${options.required ? "" : " (optional)"}. ${storedIn}`,
        {
          simple: true,
          secret: true,
          cancellable: true,
          placeholder: "Paste the key; esc picks another provider",
          validate: (inputValue: string): boolean | string => {
            if (!options.required) return true;
            if (!inputValue || inputValue.trim().length === 0) {
              return "API key cannot be empty";
            }
            return true;
          },
        },
      ),
    );

    if (answer === undefined) {
      return "cancelled";
    }

    const apiKey = answer.trim();
    if (apiKey.length === 0) {
      return "skipped";
    }

    const verdict = hasCustomEndpoint ? "unchecked" : await check(options.provider, apiKey);
    if (verdict === "rejected") {
      await Effect.runPromise(
        options.terminal.error(
          `${options.displayName} rejected this key (401). Check that it was copied whole and is still active, then paste it again, or press Esc to go back.`,
        ),
      );
      continue;
    }

    await Effect.runPromise(options.configService.set(`llm.${options.provider}.api_key`, apiKey));
    await Effect.runPromise(
      Effect.gen(function* () {
        if (verdict === "permission-denied") {
          yield* options.terminal.warn(
            `${options.displayName} denied the key check (403). A restricted key may still allow inference. The key is saved; your first model request will check that access.`,
          );
        }
        yield* options.terminal.success(
          verdict === "accepted"
            ? `${options.displayName} accepted the key. ${storedIn}`
            : `Key saved. ${storedIn}`,
        );
      }),
    );
    return "saved";
  }
}
