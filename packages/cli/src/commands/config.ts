import { envVarForSecretPath, isSecretPath } from "@jazz/adapters/secrets/registry";
import { WEB_SEARCH_PROVIDERS } from "@jazz/core/agent/tools/web-search-tools";
import { AVAILABLE_PROVIDERS, type ProviderName } from "@jazz/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { ink, TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { LoggingConfig } from "@jazz/core/types/config";
import { ConfigurationValidationError } from "@jazz/core/types/errors";
import { sortProvidersForPicker } from "@jazz/core/utils/provider-picker";
import { Effect } from "effect";
import React from "react";
import { ConfigCard } from "../ui/ConfigCard";

/**
 * CLI commands for configuration management
 */

/**
 * List all configuration values
 */
export function listConfigCommand(): Effect.Effect<
  void,
  never,
  AgentConfigService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const config = yield* configService.appConfig;

    const json = JSON.stringify(config, null, 2);

    if (process.stdout.isTTY) {
      yield* terminal.log(
        ink(
          React.createElement(ConfigCard, {
            title: "Current configuration",
            note: "Showing full values (including secrets).",
            json,
          }),
        ),
      );
      return;
    }

    yield* terminal.log(`Current configuration\n\n${json}`);
  });
}

/**
 * Get a configuration value
 * Supports nested keys (e.g., "llm.openai.api_key")
 */
export function getConfigCommand(
  key: string,
): Effect.Effect<void, never, AgentConfigService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.info(`Getting config: ${key}`);
    const configService = yield* AgentConfigServiceTag;
    const config = yield* configService.appConfig;

    const parts = key.split(".");
    let value: unknown = config;

    for (const part of parts) {
      if (value && typeof value === "object" && part in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        value = undefined;
        break;
      }
    }

    yield* terminal.log(JSON.stringify(value, null, 2));
  });
}

/**
 * Set a configuration value
 */
export function setConfigCommand(
  key: string,
  value?: string,
): Effect.Effect<void, ConfigurationValidationError, AgentConfigService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    // Intelligent handling for provider keys
    let targetKey = key;
    if (AVAILABLE_PROVIDERS.includes(key as ProviderName)) {
      targetKey = `llm.${key}.api_key`;
    } else if (
      key.startsWith("llm.") &&
      AVAILABLE_PROVIDERS.includes(key.split(".")[1] as ProviderName) &&
      key.split(".").length === 2
    ) {
      targetKey = `${key}.api_key`;
    } else if (WEB_SEARCH_PROVIDERS.some((p) => p.value === key)) {
      targetKey = `web_search.${key}.api_key`;
    } else if (
      key.startsWith("web_search.") &&
      WEB_SEARCH_PROVIDERS.some((p) => p.value === key.split(".")[1]) &&
      key.split(".").length === 2
    ) {
      targetKey = `${key}.api_key`;
    }

    if (value === undefined) {
      if (key === "llm" || targetKey.startsWith("llm.")) {
        const provider =
          targetKey.split(".")[1] ||
          (yield* terminal.select<ProviderName>("Select LLM provider:", {
            choices: sortProvidersForPicker(AVAILABLE_PROVIDERS).map((provider) => ({
              name: provider,
              value: provider,
            })),
          }));

        yield* terminal.info(`Configuring ${provider}...`);

        const apiKey = yield* terminal.ask("Enter API Key:", {
          simple: true,
          secret: true,
          cancellable: true,
          placeholder: "Paste your API key... (Esc to cancel)",
        });
        if (apiKey === undefined) {
          yield* terminal.info("Cancelled — configuration unchanged.");
          return;
        }
        yield* configService.set(`llm.${provider}.api_key`, apiKey);

        yield* terminal.success(`Configuration for ${provider} updated.`);
        return;
      }

      if (key === "web_search" || targetKey.startsWith("web_search.")) {
        const provider =
          targetKey.split(".")[1] ||
          (yield* terminal.select<string>("Select web search provider:", {
            choices: WEB_SEARCH_PROVIDERS.map((p) => ({ name: p.name, value: p.value })),
          }));

        yield* terminal.info(`Configuring ${provider}...`);

        const apiKey = yield* terminal.password("Enter API Key:");
        yield* configService.set(`web_search.${provider}.api_key`, apiKey);

        yield* terminal.success(`Configuration for ${provider} updated.`);
        return;
      }

      if (key === "logging" || targetKey.startsWith("logging.")) {
        const level = yield* terminal.select<LoggingConfig["level"]>("Select logging level:", {
          choices: ["debug", "info", "warn", "error"],
        });

        yield* configService.set("logging.level", level);
        yield* terminal.success("Logging configuration updated.");
        return;
      }

      const secret = isSecretPath(targetKey);
      const answer = yield* terminal.ask(`Enter value for ${targetKey}:`, {
        simple: true,
        cancellable: true,
        ...(secret ? { secret: true, placeholder: "Paste the value... (Esc to cancel)" } : {}),
      });
      // A cancelled or piped-empty prompt used to reach `set` as `undefined`, which stored
      // the literal string "undefined" and, for a dotted path, left an empty husk behind in
      // config.json. Nothing is a valid answer here, so nothing is written.
      if (answer === undefined || answer.trim() === "") {
        yield* terminal.info("Cancelled — configuration unchanged.");
        return;
      }
      yield* configService.set(targetKey, answer);
      yield* terminal.success(
        secret ? `Config set: ${targetKey}` : `Config set: ${targetKey} = ${answer}`,
      );
      return;
    }

    // Validation: Check if we are trying to overwrite an object with a string
    const currentValue = yield* configService.getOrElse(targetKey, undefined);
    if (
      currentValue !== undefined &&
      currentValue !== null &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue)
    ) {
      return yield* Effect.fail(
        new ConfigurationValidationError({
          field: targetKey,
          expected: "object",
          actual: "string",
          suggestion: `Cannot overwrite complex configuration object '${targetKey}' with a string value. Use specific sub-keys (e.g., '${targetKey}.someField') or interactive mode.`,
        }),
      );
    }

    // A secret is never echoed back: `jazz config set` is exactly the command somebody runs
    // while screen-sharing or pasting a terminal log into an issue.
    const settingSecret = isSecretPath(targetKey);
    yield* configService.set(targetKey, value);
    if (settingSecret && configService.secretStorageUnavailable(targetKey)) {
      yield* terminal.error(
        `Nowhere to store ${targetKey}: there is no usable keyring, and a per-entry token ` +
          `cannot live in config.json. Supply it as ${envVarForSecretPath(targetKey) ?? "an environment variable"} ` +
          `wherever the daemon runs.`,
      );
      return;
    }
    yield* terminal.success(
      settingSecret ? `Config set: ${targetKey}` : `Config set: ${targetKey} = ${value}`,
    );
  });
}
