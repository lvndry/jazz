import { FileSystem } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import type {
  AppConfig,
  ExaConfig,
  GoogleConfig,
  LLMConfig,
  LinkupConfig,
  LoggingConfig,
  StorageConfig,
} from "../core/types/index";
import { safeParseJson } from "../core/utils/json";
import { getDefaultDataDirectory } from "../core/utils/runtime-detection";

/**
 * Configuration service using Effect's Config module
 */

import { AgentConfigServiceTag, type AgentConfigService } from "../core/interfaces/agent-config";

export class AgentConfigServiceImpl implements AgentConfigService {
  private currentConfig: AppConfig;
  private configPath: string | undefined;
  private fs: FileSystem.FileSystem;

  constructor(initialConfig: AppConfig, configPath: string | undefined, fs: FileSystem.FileSystem) {
    this.currentConfig = initialConfig;
    this.configPath = configPath;
    this.fs = fs;
  }

  get<A>(key: string): Effect.Effect<A, never> {
    return Effect.sync(
      () => deepGet(this.currentConfig as unknown as Record<string, unknown>, key) as A,
    );
  }

  getOrElse<A>(key: string, fallback: A): Effect.Effect<A, never> {
    return Effect.sync(() => {
      const value = deepGet(this.currentConfig as unknown as Record<string, unknown>, key);
      return value === undefined || value === null ? fallback : (value as A);
    });
  }

  getOrFail<A>(key: string): Effect.Effect<A, never> {
    return Effect.sync(
      () => deepGet(this.currentConfig as unknown as Record<string, unknown>, key) as A,
    );
  }

  has(key: string): Effect.Effect<boolean, never> {
    return Effect.sync(() =>
      deepHas(this.currentConfig as unknown as Record<string, unknown>, key),
    );
  }

  set<A>(key: string, value: A): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        // Update in-memory config
        deepSet(this.currentConfig as unknown as Record<string, unknown>, key, value as unknown);

        // Persist to file if we have a config path
        if (this.configPath) {
          yield* this.fs.writeFileString(
            this.configPath,
            JSON.stringify(this.currentConfig, null, 2),
          );
          return;
        }

        // If no config path exists, create one at the default location
        const defaultPath = `${expandHome("~/.jazz")}/config.json`;
        this.configPath = defaultPath;

        // Ensure directory exists
        const dir = defaultPath.substring(0, defaultPath.lastIndexOf("/"));
        yield* this.fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.catchAll(() => Effect.void));
        yield* this.fs.writeFileString(defaultPath, JSON.stringify(this.currentConfig, null, 2));
      }.bind(this),
    ).pipe(Effect.catchAll(() => Effect.void));
  }

  get appConfig(): Effect.Effect<AppConfig, never> {
    return Effect.succeed(this.currentConfig);
  }
}

export function createConfigLayer(
  debug?: boolean,
  customConfigPath?: string,
): Layer.Layer<AgentConfigService, never, FileSystem.FileSystem> {
  return Layer.effect(
    AgentConfigServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const loaded = yield* loadConfigFile(fs, customConfigPath);
      const baseConfig = defaultConfig();
      const fileConfig = loaded.fileConfig ?? undefined;

      // Override logging level to debug if --debug flag is set
      const finalConfig = debug
        ? mergeConfig(baseConfig, {
            ...fileConfig,
            logging: {
              ...baseConfig.logging,
              ...fileConfig?.logging,
              level: "debug",
            },
          })
        : mergeConfig(baseConfig, fileConfig);

      return new AgentConfigServiceImpl(finalConfig, loaded.configPath, fs);
    }),
  );
}

export function getConfigValue<T>(
  key: string,
  defaultValue: T,
): Effect.Effect<T, never, AgentConfigService> {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    const result = yield* config.getOrElse(key, defaultValue);
    return result;
  });
}

export function requireConfigValue<T>(key: string): Effect.Effect<T, never, AgentConfigService> {
  return Effect.gen(function* () {
    const config = yield* AgentConfigServiceTag;
    const result = yield* config.getOrFail(key);
    return result as T;
  });
}

// -----------------
// Internal helpers
// -----------------

function defaultConfig(): AppConfig {
  const storage: StorageConfig = { type: "file", path: getDefaultDataDirectory() };
  const logging: LoggingConfig = {
    level: "info",
    format: "pretty",
    output: "console",
  };

  const google: GoogleConfig = {
    clientId: "",
    clientSecret: "",
  };

  const llm: LLMConfig = {};
  const linkup: LinkupConfig = {
    api_key: "",
  };

  const exa: ExaConfig = {
    api_key: "",
  };

  return { storage, logging, google, llm, linkup, exa };
}

function mergeConfig(base: AppConfig, override?: Partial<AppConfig>): AppConfig {
  if (!override) return base;
  return {
    storage: { ...base.storage, ...(override.storage ?? {}) },
    logging: { ...base.logging, ...(override.logging ?? {}) },
    ...(override.output && {
      output: {
        ...base.output,
        // Explicitly merge top-level output properties
        ...(override.output.showThinking !== undefined
          ? { showThinking: override.output.showThinking }
          : {}),
        ...(override.output.showToolExecution !== undefined
          ? { showToolExecution: override.output.showToolExecution }
          : {}),
        ...(override.output.mode !== undefined ? { mode: override.output.mode } : {}),
        ...(override.output.colorProfile !== undefined
          ? { colorProfile: override.output.colorProfile }
          : {}),
        // Merge streaming config
        ...(override.output.streaming && {
          streaming: { ...(base.output?.streaming ?? {}), ...override.output.streaming },
        }),
      },
    }),
    ...(override.google && { google: { ...base.google, ...override.google } }),
    ...(override.llm && { llm: { ...(base.llm ?? {}), ...override.llm } }),
    ...(override.linkup && { linkup: { ...base.linkup, ...override.linkup } }),
    ...(override.exa && { exa: { ...base.exa, ...override.exa } }),
  };
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
    return home ? p.replace(/^~/, home) : p;
  }
  return p;
}

function loadConfigFile(
  fs: FileSystem.FileSystem,
  customConfigPath?: string,
): Effect.Effect<
  {
    configPath?: string;
    fileConfig?: Partial<AppConfig>;
  },
  never
> {
  return Effect.gen(function* () {
    // If custom config path is provided, validate and use it exclusively
    if (customConfigPath) {
      const expandedPath = expandHome(customConfigPath);
      const exists = yield* fs
        .exists(expandedPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (!exists) {
        console.error(`\n❌ Error: Config file not found at: ${expandedPath}`);
        console.error(`\nPlease ensure the file exists and the path is correct.\n`);
        process.exit(1);
      }

      const contentResult = yield* fs.readFileString(expandedPath).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error(`\n❌ Error: Cannot read config file at: ${expandedPath}`);
            console.error(`Reason: ${String(error)}\n`);
            process.exit(1);
          }),
        ),
      );

      const content = contentResult;

      if (!content) {
        console.error(`\n❌ Error: Config file is empty: ${expandedPath}\n`);
        process.exit(1);
      }

      const parsed = safeParseJson<Partial<AppConfig>>(content);
      if (Option.isNone(parsed)) {
        console.error(`\n❌ Error: Invalid JSON in config file: ${expandedPath}`);
        console.error(`\nPlease ensure the file contains valid JSON.`);
        process.exit(1);
      }

      // Validate that the parsed config matches AppConfig structure
      const config = parsed.value;
      if (typeof config !== "object" || config === null) {
        console.error(
          `\n❌ Error: Config file must contain a valid configuration object: ${expandedPath}`,
        );
        console.error(`\nExpected format: { "llm": {...}, "storage": {...}, ... }\n`);
        process.exit(1);
      }

      return { configPath: expandedPath, fileConfig: config };
    }

    // Otherwise, use the default search order
    const envConfigPath = process.env["JAZZ_CONFIG_PATH"];
    const candidates: readonly string[] = [
      envConfigPath ? expandHome(envConfigPath) : "",
      `${process.cwd()}/.jazz/config.json`,
      `${process.cwd()}/jazz.config.json`,
      `${expandHome("~/.jazz")}/config.json`,
    ].filter(Boolean);

    for (const path of candidates) {
      const exists = yield* fs.exists(path).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!exists) continue;
      const content = yield* fs
        .readFileString(path)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      if (!content) return { configPath: path };
      const parsed = safeParseJson<Partial<AppConfig>>(content);
      if (Option.isSome(parsed)) {
        return { configPath: path, fileConfig: parsed.value };
      }
      // If parse failed, ignore and continue to next
    }

    return {};
  });
}

/**
 * Deep object property access using dot notation paths.
 *
 * The 'path' parameter uses dot notation to navigate nested objects:
 * - "name" -> obj.name
 * - "storage.type" -> obj.storage.type
 * - "logging.level" -> obj.logging.level
 *
 * This allows flexible access to both simple and deeply nested properties
 * using the same interface, commonly used in configuration management.
 */
function deepGet(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Checks if a property exists at the given dot notation path.
 * Uses deepGet internally to determine existence.
 */
function deepHas(obj: Record<string, unknown>, path: string): boolean {
  return deepGet(obj, path) !== undefined;
}

/**
 * Sets a value at the given dot notation path, creating intermediate objects as needed.
 *
 * Example: deepSet(obj, "storage.type", "file") sets obj.storage.type = "file"
 * If obj.storage doesn't exist, it will be created as an empty object first.
 */
function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i] as string;
    if (i === parts.length - 1) {
      cur[key] = value;
    } else {
      const next = cur[key];
      if (!next || typeof next !== "object") {
        cur[key] = {} as unknown;
      }
      cur = cur[key] as Record<string, unknown>;
    }
  }
}
