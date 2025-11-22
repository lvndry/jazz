import { Effect } from "effect";
import { ConfigurationValidationError } from "../../core/types/errors";
import { AgentConfigService, type ConfigService } from "../../services/config";
import { AVAILABLE_PROVIDERS } from "../../services/llm/models";
import { TerminalServiceTag, type TerminalService } from "../../services/terminal";

/**
 * CLI commands for configuration management
 */

/**
 * List all configuration values
 */
export function listConfigCommand(): Effect.Effect<void, never, ConfigService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigService;
    const config = yield* configService.appConfig;
    yield* terminal.heading("Current Configuration");
    yield* terminal.log(JSON.stringify(config, null, 2));
  });
}

/**
 * Get a configuration value
 * Supports nested keys (e.g., "llm.openai.api_key")
 */
export function getConfigCommand(
  key: string,
): Effect.Effect<void, never, ConfigService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.info(`Getting config: ${key}`);
    const configService = yield* AgentConfigService;
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
 * Supports nested keys (e.g., "llm.openai.api_key")
 */
export function setConfigCommand(
  key: string,
  value?: string,
): Effect.Effect<void, ConfigurationValidationError, ConfigService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigService;

    if (value === undefined) {
      if (key === "llm") {
        const provider = yield* terminal.select("Select LLM provider:", AVAILABLE_PROVIDERS);

        yield* terminal.info(`Configuring ${provider}...`);

        const apiKey = yield* terminal.ask("Enter API Key:");
        yield* configService.set(`llm.${provider}.api_key`, apiKey);

        yield* terminal.success(`Configuration for ${provider} updated.`);
        return;
      }

      if (key === "google") {
        const clientId = yield* terminal.ask("Enter Client ID:");
        const clientSecret = yield* terminal.password("Enter Client Secret:");
        yield* configService.set("google.clientId", clientId);
        yield* configService.set("google.clientSecret", clientSecret);
        yield* terminal.success("Google configuration updated.");
        return;
      }

      if (key === "linkup") {
        const apiKey = yield* terminal.password("Enter Linkup API Key:");
        yield* configService.set("linkup.api_key", apiKey);
        yield* terminal.success("Linkup configuration updated.");
        return;
      }

      if (key === "exa") {
        const apiKey = yield* terminal.password("Enter Exa API Key:");
        yield* configService.set("exa.api_key", apiKey);
        yield* terminal.success("Exa configuration updated.");
        return;
      }

      if (key === "logging") {
        const level = yield* terminal.select("Select logging level:", [
          "debug",
          "info",
          "warn",
          "error",
        ]);
        yield* configService.set("logging.level", level);
        yield* terminal.success("Logging configuration updated.");
        return;
      }

      const answer = yield* terminal.ask(`Enter value for ${key}:`);
      yield* terminal.info(`Setting config: ${key} = ${answer}`);
      yield* configService.set(key, answer);
      yield* terminal.success(`Config set: ${key} = ${answer}`);
      return;
    }

    // Validation: Check if we are trying to overwrite an object with a string
    const currentValue = yield* configService.getOrElse(key, undefined);
    if (
      currentValue !== undefined &&
      currentValue !== null &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue)
    ) {
      return yield* Effect.fail(
        new ConfigurationValidationError({
          field: key,
          expected: "object",
          actual: "string",
          suggestion: `Cannot overwrite complex configuration object '${key}' with a string value. Use specific sub-keys (e.g., '${key}.someField') or interactive mode.`,
        }),
      );
    }

    yield* terminal.info(`Setting config: ${key} = ${value}`);
    yield* configService.set(key, value);
    yield* terminal.success(`Config set: ${key} = ${value}`);
  });
}
