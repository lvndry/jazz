import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Option } from "effect";
import type {
  AppConfig,
  GoogleConfig,
  LLMConfig,
  LinkupConfig,
  LoggingConfig,
  StorageConfig
} from "../core/types/index";

/**
 * Configuration service using Effect's Config module
 */

export interface ConfigService {
  readonly get: <A>(key: string) => Effect.Effect<A, never>;
  readonly getOrElse: <A>(key: string, fallback: A) => Effect.Effect<A, never>;
  readonly getOrFail: <A>(key: string) => Effect.Effect<A, never>;
  readonly has: (key: string) => Effect.Effect<boolean, never>;
  readonly set: <A>(key: string, value: A) => Effect.Effect<void, never>;
  readonly appConfig: Effect.Effect<AppConfig, never>;
}

export class ConfigServiceImpl implements ConfigService {
  private currentConfig: AppConfig;
  constructor(initialConfig: AppConfig) {
    this.currentConfig = initialConfig;
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
    return Effect.sync(() => {
      deepSet(this.currentConfig as unknown as Record<string, unknown>, key, value as unknown);
    });
  }

  get appConfig(): Effect.Effect<AppConfig, never> {
    return Effect.succeed(this.currentConfig);
  }
}

export const AgentConfigService = Context.GenericTag<ConfigService>("ConfigService");

export function createConfigLayer(
  debug?: boolean,
): Layer.Layer<ConfigService, never, FileSystem.FileSystem> {
  return Layer.effect(
    AgentConfigService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const loaded = yield* loadConfigFile(fs);
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

      return new ConfigServiceImpl(finalConfig);
    }),
  );
}

export function getConfigValue<T>(
  key: string,
  defaultValue: T,
): Effect.Effect<T, never, ConfigService> {
  return Effect.gen(function* () {
    const config = yield* AgentConfigService;
    const result = yield* config.getOrElse(key, defaultValue);
    return result;
  });
}

export function requireConfigValue<T>(key: string): Effect.Effect<T, never, ConfigService> {
  return Effect.gen(function* () {
    const config = yield* AgentConfigService;
    const result = yield* config.getOrFail(key);
    return result as T;
  });
}

// -----------------
// Internal helpers
// -----------------

function defaultConfig(): AppConfig {
  const storage: StorageConfig = { type: "file", path: "./.jazz" };
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
    apiKey: "",
    baseUrl: "https://api.linkup.so",
    timeout: 30000,
  };

  return { storage, logging, google, llm, linkup };
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
        ...(override.output.colorProfile !== undefined ? { colorProfile: override.output.colorProfile } : {}),
        // Merge streaming config
        ...(override.output.streaming && {
          streaming: { ...(base.output?.streaming ?? {}), ...override.output.streaming },
        }),
      },
    }),
    ...(override.google && { google: { ...base.google, ...override.google } }),
    ...(override.llm && { llm: { ...(base.llm ?? {}), ...override.llm } }),
    ...(override.linkup && { linkup: { ...base.linkup, ...override.linkup } }),
  };
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
    return home ? p.replace(/^~/, home) : p;
  }
  return p;
}

function loadConfigFile(fs: FileSystem.FileSystem): Effect.Effect<
  {
    configPath?: string;
    fileConfig?: Partial<AppConfig>;
  },
  never
> {
  return Effect.gen(function* () {
    const envConfigPath = process.env["JAZZ_CONFIG_PATH"];
    const candidates: readonly string[] = [
      envConfigPath ? expandHome(envConfigPath) : "",
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

function safeParseJson<T>(text: string): Option.Option<T> {
  try {
    return Option.some(JSON.parse(text) as T);
  } catch {
    return Option.none();
  }
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
