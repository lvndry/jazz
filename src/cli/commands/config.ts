import { Effect } from "effect";
import React from "react";
import { WEB_SEARCH_PROVIDERS } from "@/core/agent/tools/web-search-tools";
import { AVAILABLE_PROVIDERS, type ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { ink, TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import type { LoggingConfig } from "@/core/types/config";
import { ConfigurationValidationError } from "@/core/types/errors";
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
    let value: unknown = config as unknown;

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
    } else if (key.startsWith("llm.") && AVAILABLE_PROVIDERS.includes(key.split(".")[1] as ProviderName) && key.split(".").length === 2) {
      targetKey = `${key}.api_key`;
    } else if (WEB_SEARCH_PROVIDERS.some(p => p.value === key)) {
      targetKey = `web_search.${key}.api_key`;
    } else if (key.startsWith("web_search.") && WEB_SEARCH_PROVIDERS.some(p => p.value === key.split(".")[1]) && key.split(".").length === 2) {
      targetKey = `${key}.api_key`;
    }

    if (value === undefined) {
      if (key === "llm" || targetKey.startsWith("llm.")) {
        const provider = targetKey.split(".")[1] || (yield* terminal.select<ProviderName>("Select LLM provider:", {
          choices: AVAILABLE_PROVIDERS.map((provider) => ({
            name: provider,
            value: provider,
          })),
        }));

        yield* terminal.info(`Configuring ${provider}...`);

        const apiKey = yield* terminal.ask("Enter API Key:");
        yield* configService.set(`llm.${provider}.api_key`, apiKey);

        yield* terminal.success(`Configuration for ${provider} updated.`);
        return;
      }

      if (key === "google" || targetKey.startsWith("google.")) {
        const clientId = yield* terminal.ask("Enter Client ID:");
        const clientSecret = yield* terminal.password("Enter Client Secret:");
        yield* configService.set("google.clientId", clientId);
        yield* configService.set("google.clientSecret", clientSecret);
        yield* terminal.success("Google configuration updated.");
        return;
      }

      if (key === "web_search" || targetKey.startsWith("web_search.")) {
        const provider = targetKey.split(".")[1] || (yield* terminal.select<string>("Select web search provider:", {
          choices: WEB_SEARCH_PROVIDERS.map(p => ({ name: p.name, value: p.value as string })),
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

      const answer = yield* terminal.ask(`Enter value for ${targetKey}:`);
      yield* terminal.info(`Setting config: ${targetKey} = ${answer}`);
      yield* configService.set(targetKey, answer);
      yield* terminal.success(`Config set: ${targetKey} = ${answer}`);
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

    yield* terminal.info(`Setting config: ${targetKey} = ${value}`);
    yield* configService.set(targetKey, value);
    yield* terminal.success(`Config set: ${targetKey} = ${value}`);
  });
}
