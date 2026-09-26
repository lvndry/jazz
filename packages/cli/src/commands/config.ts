import { envVarForSecretPath, isSecretPath } from "@jazz/adapters/secrets/registry";
import { WEB_SEARCH_PROVIDERS } from "@jazz/core/agent/tools/web-search";
import { AVAILABLE_PROVIDERS, type ProviderName } from "@jazz/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { ink, TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { LoggingConfig } from "@jazz/core/types/config";
import { ConfigurationValidationError } from "@jazz/core/types/errors";
import {
  type ConfigValueKind,
  parseConfigInput,
  resolveConfigPath,
} from "@jazz/core/utils/config-schema";
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

/** What to type instead, for a value the setting's schema could not read. */
function valueHint(kind: ConfigValueKind, expected: string): string {
  switch (kind) {
    case "whole-number":
      return "Pass a plain whole number, with no units or quotes — 600000, not 600000ms.";
    case "number":
      return "Pass a plain number, with no units or quotes — 0.8, not 80%.";
    case "boolean":
      return "Pass true or false (yes/no, on/off and 1/0 are read too).";
    case "choice":
      return `Pass ${expected}.`;
    case "text":
      return "Pass the value as plain text.";
  }
}

function unknownSettingError(path: string, suggestion?: string): ConfigurationValidationError {
  return new ConfigurationValidationError({
    field: path,
    expected: "a setting Jazz reads",
    actual: "a key it does not know",
    suggestion:
      suggestion === undefined
        ? "Check the key against the configuration docs; Jazz refuses keys it would never read."
        : `Did you mean ${suggestion}?`,
  });
}

function sectionError(path: string): ConfigurationValidationError {
  return new ConfigurationValidationError({
    field: path,
    expected: "one of its fields",
    actual: "a single value for the whole section",
    suggestion: `Set a field inside it instead, e.g. '${path}.someField'.`,
  });
}

/**
 * Convert one raw CLI string to the type its config path declares, failing the command when the
 * path is not a setting or the value cannot be read as that setting's type.
 *
 * Falling back to the string would be worse than refusing: config.json would still parse, and
 * every reader of that setting would then ignore it. Secrets are opaque text and pass through.
 */
function typedConfigValue(
  path: string,
  raw: string,
): Effect.Effect<string | number | boolean, ConfigurationValidationError> {
  if (isSecretPath(path)) return Effect.succeed(raw);
  const input = parseConfigInput(path, raw);
  if (input.ok) return Effect.succeed(input.value);
  switch (input.reason) {
    case "unknown-key":
      return Effect.fail(unknownSettingError(path, input.suggestion));
    case "structured":
      return Effect.fail(sectionError(path));
    case "invalid":
      return Effect.fail(
        new ConfigurationValidationError({
          field: path,
          expected: input.expected,
          actual: raw,
          suggestion: valueHint(input.kind, input.expected),
        }),
      );
  }
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

        if (provider === "anthropic") {
          const workspaceId = yield* terminal.ask(
            "Anthropic workspace ID (only needed with an identity-linked API key; leave empty to skip):",
            { simple: true },
          );
          if (workspaceId?.trim()) {
            yield* configService.set("llm.anthropic.workspace_id", workspaceId.trim());
          }
        }

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
      const resolution = secret ? undefined : resolveConfigPath(targetKey);
      if (resolution !== undefined && !resolution.known) {
        return yield* Effect.fail(unknownSettingError(targetKey, resolution.suggestion));
      }
      if (resolution?.structured) {
        return yield* Effect.fail(sectionError(targetKey));
      }
      const answer = yield* terminal.ask(`Enter value for ${targetKey}:`, {
        simple: true,
        cancellable: true,
        ...(secret ? { secret: true, placeholder: "Paste the value... (Esc to cancel)" } : {}),
      });
      // Nothing is a valid answer: `set(undefined)` stored the literal string.
      if (answer === undefined || answer.trim() === "") {
        yield* terminal.info("Cancelled — configuration unchanged.");
        return;
      }
      const typedAnswer = yield* typedConfigValue(targetKey, answer);
      yield* configService.set(targetKey, typedAnswer);
      yield* terminal.success(
        secret ? `Config set: ${targetKey}` : `Config set: ${targetKey} = ${String(typedAnswer)}`,
      );
      return;
    }

    const settingSecret = isSecretPath(targetKey);
    const typedValue = yield* typedConfigValue(targetKey, value);
    yield* configService.set(targetKey, typedValue);
    if (settingSecret && configService.secretStorageUnavailable(targetKey)) {
      yield* terminal.error(
        `Nowhere to store ${targetKey}: there is no usable keyring, and a per-entry token ` +
          `cannot live in config.json. Supply it as ${envVarForSecretPath(targetKey) ?? "an environment variable"} ` +
          `wherever the daemon runs.`,
      );
      return;
    }
    yield* terminal.success(
      settingSecret
        ? `Config set: ${targetKey}`
        : `Config set: ${targetKey} = ${String(typedValue)}`,
    );
  });
}
