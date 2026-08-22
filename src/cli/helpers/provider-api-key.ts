import { Effect } from "effect";
import { configuredProviderNames } from "@/cli/ui/fullscreen/home-readiness";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { TerminalService } from "@/core/interfaces/terminal";

export type ProviderApiKeyPromptResult = "saved" | "already-set" | "skipped" | "cancelled";

/**
 * Prompt for a provider API key when none is configured (config, keyring, or env).
 * Empty input is never persisted — that used to make `has()` report a key that
 * chat then sent as a blank Bearer token.
 */
export async function ensureProviderApiKey(options: {
  readonly configService: AgentConfigService;
  readonly terminal: TerminalService;
  readonly provider: string;
  readonly displayName: string;
  readonly required: boolean;
  readonly reason?: string;
}): Promise<ProviderApiKeyPromptResult> {
  const config = await Effect.runPromise(options.configService.appConfig);
  if (configuredProviderNames(config).includes(options.provider)) {
    return "already-set";
  }

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* options.terminal.log("");
      if (options.reason) {
        yield* options.terminal.warn(options.reason);
      } else {
        yield* options.terminal.warn(`API key not set for ${options.displayName}.`);
      }
      yield* options.terminal.log("Please paste your API key below:");
    }),
  );

  const apiKey = await Effect.runPromise(
    options.terminal.ask(
      `${options.displayName} API Key${options.required ? "" : " (optional)"}:`,
      {
        simple: true,
        secret: true,
        cancellable: true,
        placeholder: "Paste your API key... (Esc to go back)",
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

  if (apiKey === undefined) {
    return "cancelled";
  }

  if (apiKey.trim().length === 0) {
    return "skipped";
  }

  await Effect.runPromise(options.configService.set(`llm.${options.provider}.api_key`, apiKey));
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* options.terminal.success("API key saved.");
      yield* options.terminal.log("");
    }),
  );
  return "saved";
}
