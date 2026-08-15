import { FileSystem } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import { ConfigurationError, ConfigurationNotFoundError } from "@/core/types/errors";
import type {
  AppConfig,
  LLMConfig,
  LoggingConfig,
  MCPServerOverride,
  StorageConfig,
  WebSearchConfig,
} from "@/core/types/index";
import { safeParseJson } from "@/core/utils/json";
import {
  getGlobalUserDataDirectory,
  getJazzHomeDirectory,
  getLocalJazzDirectory,
} from "@/core/utils/paths";
import {
  migrateConfigProviderName,
  migrateKeyringProviderName,
} from "@/core/utils/provider-migration";
import {
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringSet,
  type KeyringBackend,
} from "./secrets/keyring";
import { SECRET_PATHS, envVarForSecretPath, isSecretPath } from "./secrets/registry";

/**
 * ~/.jazz/config.json can hold API keys, so it is created private to the user
 * and repaired on load — a default umask would otherwise leave it world-readable.
 */
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

/** Where a resolved secret came from. Anything but "file" must never be persisted. */
type SecretOrigin = "env" | "keyring";

/**
 * Extract only override fields (enabled) from a server config.
 * Used when persisting to ~/.jazz/config.json — full definitions live in mcp.json.
 */
function extractMcpOverride(entry: unknown): MCPServerOverride | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const entryData = entry as Record<string, unknown>;
  if (typeof entryData["enabled"] !== "boolean") return undefined;
  return { enabled: entryData["enabled"] };
}

/**
 * Build jazz config for persistence: full config but mcpServers replaced by
 * overrides only, and secrets held elsewhere (env or keyring) left out entirely
 * so resolving a key at runtime never causes it to be written back to disk.
 */
function buildJazzConfigForPersist(
  config: AppConfig,
  mcpOverrides: Record<string, MCPServerOverride>,
  secretOrigins: ReadonlyMap<string, SecretOrigin>,
  fileSecrets: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const json = config as unknown as Record<string, unknown>;
  const out = structuredClone(json);
  out["mcpServers"] = Object.keys(mcpOverrides).length > 0 ? mcpOverrides : undefined;
  for (const path of secretOrigins.keys()) {
    deepDelete(out, path);
  }
  // Restore what the file itself owns, so an env var that merely shadows a
  // stored key at runtime does not erase it from disk.
  for (const [path, value] of fileSecrets) {
    deepSet(out, path, value);
  }
  return out;
}

/**
 * Configuration service using Effect's Config module
 */
export class AgentConfigServiceImpl implements AgentConfigService {
  private currentConfig: AppConfig;
  private mcpOverrides: Record<string, MCPServerOverride>;
  private configPath: string | undefined;
  private fs: FileSystem.FileSystem;
  private currentRevision: number;
  private keyringBackend: KeyringBackend;
  private secretOrigins: Map<string, SecretOrigin>;
  private fileSecrets: Map<string, string>;

  constructor(
    initialConfig: AppConfig,
    mcpOverrides: Record<string, MCPServerOverride>,
    configPath: string | undefined,
    fs: FileSystem.FileSystem,
    keyringBackend: KeyringBackend = "none",
    secretOrigins: ReadonlyMap<string, SecretOrigin> = new Map(),
    fileSecrets: ReadonlyMap<string, string> = new Map(),
  ) {
    this.currentConfig = initialConfig;
    this.mcpOverrides = mcpOverrides;
    this.configPath = configPath;
    this.fs = fs;
    this.currentRevision = 0;
    this.keyringBackend = keyringBackend;
    this.secretOrigins = new Map(secretOrigins);
    this.fileSecrets = new Map(fileSecrets);
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

  /**
   * Handle MCP-related set() keys by updating overrides and in-memory config.
   * Returns an Effect that resolves to true if the key was handled.
   */
  private setMcpOverride(key: string, value: unknown): Effect.Effect<boolean, never> {
    if (key === "mcpServers") {
      // Bulk replace overrides (e.g. from remove command)
      return Effect.gen(
        function* (this: AgentConfigServiceImpl) {
          const val = value as Record<string, unknown>;
          this.mcpOverrides = Object.fromEntries(
            Object.entries(val ?? {})
              .map(([k, v]) => [k, extractMcpOverride(v)])
              .filter((entry): entry is [string, MCPServerOverride] => entry[1] !== undefined),
          );
          const agentsServers = yield* loadAgentsMcpServers(this.fs);
          this.currentConfig = {
            ...this.currentConfig,
            mcpServers: mergeMcpServers(agentsServers, this.mcpOverrides),
          };
          return true;
        }.bind(this),
      );
    }

    if (!key.startsWith("mcpServers.")) return Effect.succeed(false);

    const rest = key.slice("mcpServers.".length);
    const dotIndex = rest.indexOf(".");
    const serverName = dotIndex === -1 ? rest : rest.slice(0, dotIndex);
    if (!serverName) return Effect.succeed(false);

    if (dotIndex === -1) {
      // set("mcpServers.X", { enabled: true }) — merge override
      const val = value as Record<string, unknown>;
      const next = extractMcpOverride(val) ?? {};
      this.mcpOverrides[serverName] = { ...this.mcpOverrides[serverName], ...next };
      const cfg = this.currentConfig.mcpServers?.[serverName] as
        Record<string, unknown> | undefined;
      deepSet(this.currentConfig as unknown as Record<string, unknown>, key, {
        ...cfg,
        ...val,
      });
    } else {
      // set("mcpServers.X.enabled", value)
      const prop = rest.slice(dotIndex + 1);
      if (prop === "enabled") {
        this.mcpOverrides[serverName] = {
          ...this.mcpOverrides[serverName],
          enabled: value as boolean,
        };
      }
      deepSet(this.currentConfig as unknown as Record<string, unknown>, key, value);
    }
    return Effect.succeed(true);
  }

  set<A>(key: string, value: A): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        const handled = yield* this.setMcpOverride(key, value);
        if (!handled) {
          deepSet(this.currentConfig as unknown as Record<string, unknown>, key, value);
        }

        if (isSecretPath(key)) {
          yield* this.storeSecret(key, value);
        }

        // Persist to file
        const path = this.configPath ?? `${getJazzHomeDirectory()}/config.json`;
        if (!this.configPath) {
          this.configPath = path;
          const dir = path.substring(0, path.lastIndexOf("/"));
          yield* this.fs
            .makeDirectory(dir, { recursive: true, mode: CONFIG_DIR_MODE })
            .pipe(Effect.catchAll(() => Effect.void));
        }

        const toWrite = buildJazzConfigForPersist(
          this.currentConfig,
          this.mcpOverrides,
          this.secretOrigins,
          this.fileSecrets,
        );
        yield* writePrivateFile(this.fs, path, JSON.stringify(toWrite, null, 2));
        this.currentRevision += 1;
      }.bind(this),
    ).pipe(Effect.catchAll(() => Effect.void));
  }

  /**
   * Route a secret to the keyring when one is usable, recording where it now
   * lives so it is excluded from the config file on persist. Falls through to
   * file storage (mode 0600) when there is no keyring.
   */
  private storeSecret(key: string, value: unknown): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        const isBlank = typeof value !== "string" || value.trim() === "";
        if (isBlank) {
          yield* keyringDelete(this.keyringBackend, key);
          this.secretOrigins.delete(key);
          this.fileSecrets.delete(key);
          return;
        }

        const stored = yield* keyringSet(this.keyringBackend, key, value);
        if (stored) {
          this.secretOrigins.set(key, "keyring");
          this.fileSecrets.delete(key);
          return;
        }

        // No usable keyring: the value stays in the config file, which
        // writePrivateFile keeps at mode 0600.
        this.secretOrigins.delete(key);
        this.fileSecrets.set(key, value);
      }.bind(this),
    );
  }

  get revision(): Effect.Effect<number, never> {
    return Effect.succeed(this.currentRevision);
  }

  get appConfig(): Effect.Effect<AppConfig, never> {
    return Effect.succeed(this.currentConfig);
  }
}

function mergeMcpServers(
  agents: Record<string, MCPServerConfig>,
  overrides: Record<string, MCPServerOverride>,
): Record<string, MCPServerConfig> {
  const merged: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(agents)) {
    const ov = overrides[name];
    merged[name] = {
      ...cfg,
      ...(ov?.enabled !== undefined ? { enabled: ov.enabled } : {}),
    };
  }
  return merged;
}

export function createConfigLayer(
  debug?: boolean,
  customConfigPath?: string,
): Layer.Layer<
  AgentConfigService,
  ConfigurationError | ConfigurationNotFoundError,
  FileSystem.FileSystem
> {
  return Layer.effect(
    AgentConfigServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const loaded = yield* loadConfigFile(fs, customConfigPath);
      const baseConfig = defaultConfig();
      const fileConfig = loaded.fileConfig ?? undefined;

      // Merge main config (base + file), excluding mcpServers — handled separately
      const fileConfigWithoutMcp = fileConfig
        ? (() => {
            const { mcpServers: _m, ...rest } = fileConfig;
            return rest as Partial<AppConfig>;
          })()
        : undefined;
      const mainConfig = debug
        ? mergeConfig(baseConfig, {
            ...fileConfigWithoutMcp,
            logging: {
              ...baseConfig.logging,
              ...fileConfig?.logging,
              level: "debug",
            },
          })
        : mergeConfig(baseConfig, fileConfigWithoutMcp);

      // Load MCP definitions from .agents/mcp.json
      const agentsServers = yield* loadAgentsMcpServers(fs);

      // Extract overrides from global + local jazz config (local wins)
      const mcpOverrides = {
        ...extractMcpOverridesFromFile(loaded.globalConfig?.mcpServers),
        ...extractMcpOverridesFromFile(loaded.localConfig?.mcpServers),
      };

      const finalConfig = mergeAgentsMcpIntoConfig(mainConfig, agentsServers, mcpOverrides);

      const keyringBackend = yield* detectKeyringBackend();
      const secrets = yield* resolveSecrets(
        fs,
        finalConfig,
        loaded.configPath,
        loaded.globalConfig,
        keyringBackend,
        loaded.renamedProvider ?? false,
      );

      return new AgentConfigServiceImpl(
        secrets.config,
        mcpOverrides,
        loaded.configPath,
        fs,
        keyringBackend,
        secrets.origins,
        secrets.fileSecrets,
      );
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
  const storage: StorageConfig = { type: "file", path: getGlobalUserDataDirectory() };
  const logging: LoggingConfig = {
    level: "info",
    format: "plain",
  };

  const llm: LLMConfig = {};
  const web_search: WebSearchConfig = {};

  return { storage, logging, llm, web_search };
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
        ...(override.output.showMetrics !== undefined
          ? { showMetrics: override.output.showMetrics }
          : {}),
        // Merge streaming config
        ...(override.output.streaming && {
          streaming: { ...(base.output?.streaming ?? {}), ...override.output.streaming },
        }),
      },
    }),
    ...(override.llm && { llm: { ...(base.llm ?? {}), ...override.llm } }),
    ...(override.web_search && {
      web_search: { ...(base.web_search ?? {}), ...override.web_search },
    }),
    ...(override.mcpServers && {
      mcpServers: { ...(base.mcpServers ?? {}), ...override.mcpServers },
    }),
    ...(override.notifications && {
      notifications: { ...(base.notifications ?? {}), ...override.notifications },
    }),
    ...(override.autoApprovedCommands && {
      autoApprovedCommands: override.autoApprovedCommands,
    }),
    ...(override.maxRetries !== undefined && { maxRetries: override.maxRetries }),
    ...(override.maxSubagentDepth !== undefined && {
      maxSubagentDepth: override.maxSubagentDepth,
    }),
    ...(override.maxIterations !== undefined && { maxIterations: override.maxIterations }),
    ...(override.maxSubagentIterations !== undefined && {
      maxSubagentIterations: override.maxSubagentIterations,
    }),
    ...(override.telemetry && {
      telemetry: {
        ...(base.telemetry ?? {}),
        ...override.telemetry,
        ...(override.telemetry.otlp && {
          otlp: { ...(base.telemetry?.otlp ?? {}), ...override.telemetry.otlp },
        }),
      },
    }),
  };
}

/**
 * Write a file that only the owning user can read, repairing the mode on files
 * that already exist — `writeFileString`'s mode applies solely at creation.
 */
function writePrivateFile(
  fs: FileSystem.FileSystem,
  filePath: string,
  content: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* fs
      .writeFileString(filePath, content, { mode: CONFIG_FILE_MODE })
      .pipe(Effect.catchAll(() => Effect.void));
    yield* chmodQuietly(fs, filePath, CONFIG_FILE_MODE);
  });
}

/** chmod that tolerates both failures and FileSystem stubs without `chmod`. */
function chmodQuietly(
  fs: FileSystem.FileSystem,
  filePath: string,
  mode: number,
): Effect.Effect<void, never> {
  return Effect.suspend(() => fs.chmod(filePath, mode)).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.catchAllDefect(() => Effect.void),
  );
}

/**
 * Every secret-bearing path present in a config, including providers Jazz does
 * not ship support for, so nothing is left behind in plaintext.
 */
function collectSecretPaths(config: Partial<AppConfig>): string[] {
  const record = config as unknown as Record<string, unknown>;
  const paths: string[] = [];

  for (const section of ["llm", "web_search"]) {
    const providers = record[section];
    if (!providers || typeof providers !== "object") continue;
    for (const [provider, providerConfig] of Object.entries(providers)) {
      if (!providerConfig || typeof providerConfig !== "object") continue;
      if (typeof (providerConfig as Record<string, unknown>)["api_key"] !== "string") continue;
      paths.push(`${section}.${provider}.api_key`);
    }
  }

  // Pick up OTLP headers by whatever name the backend uses, so a credential
  // under a non-standard header still migrates out of the file.
  const otlpHeaders = (record["telemetry"] as Record<string, unknown> | undefined)?.["otlp"] as
    Record<string, unknown> | undefined;
  const headers = otlpHeaders?.["headers"];
  if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") paths.push(`telemetry.otlp.headers.${name}`);
    }
  }

  return paths;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Resolve secrets in precedence order — environment, then keyring, then the
 * config file — and move any plaintext left in the global config file into the
 * keyring when one is available.
 */
function resolveSecrets(
  fs: FileSystem.FileSystem,
  config: AppConfig,
  globalConfigPath: string | undefined,
  globalFileConfig: Partial<AppConfig> | undefined,
  backend: KeyringBackend,
  renamedProvider: boolean,
): Effect.Effect<
  {
    config: AppConfig;
    origins: Map<string, SecretOrigin>;
    fileSecrets: Map<string, string>;
  },
  never
> {
  return Effect.gen(function* () {
    yield* migrateKeyringProviderName(backend, keyringGet, keyringSet, keyringDelete);

    const resolved = structuredClone(config) as unknown as Record<string, unknown>;
    const origins = new Map<string, SecretOrigin>();
    const candidates = new Set([...SECRET_PATHS, ...collectSecretPaths(config)]);

    for (const path of candidates) {
      const envVar = envVarForSecretPath(path);
      const envValue = envVar ? process.env[envVar] : undefined;
      if (nonEmptyString(envValue)) {
        deepSet(resolved, path, envValue);
        origins.set(path, "env");
      }
    }

    if (backend !== "none") {
      const lookups = [...candidates].filter((path) => !origins.has(path));
      const found = yield* Effect.all(
        lookups.map((path) =>
          keyringGet(backend, path).pipe(Effect.map((value) => [path, value] as const)),
        ),
        { concurrency: "unbounded" },
      );
      for (const [path, value] of found) {
        if (!nonEmptyString(value)) continue;
        deepSet(resolved, path, value);
        origins.set(path, "keyring");
      }
    }

    const fileRecord = (globalFileConfig ?? {}) as unknown as Record<string, unknown>;
    const migrated = yield* migratePlaintextSecrets(backend, fileRecord, candidates);
    for (const path of migrated) {
      origins.set(path, "keyring");
    }

    // Secrets the file still legitimately owns. Kept verbatim so that a shadowing
    // env var never causes the stored copy to be dropped on the next write.
    const fileSecrets = new Map<string, string>();
    for (const path of candidates) {
      if (migrated.includes(path)) continue;
      const fileValue = deepGet(fileRecord, path);
      if (nonEmptyString(fileValue)) fileSecrets.set(path, fileValue);
    }

    const droppedLegacy = dropLegacyGoogleBlock(fileRecord);

    if ((migrated.length > 0 || droppedLegacy || renamedProvider) && globalConfigPath) {
      const cleaned = structuredClone(fileRecord);
      for (const path of migrated) {
        deepDelete(cleaned, path);
      }
      if (droppedLegacy) delete cleaned["google"];
      yield* writePrivateFile(fs, globalConfigPath, JSON.stringify(cleaned, null, 2));
      if (droppedLegacy) noticeLegacyGoogleRemoved(globalConfigPath);
    } else if (globalConfigPath) {
      yield* chmodQuietly(fs, globalConfigPath, CONFIG_FILE_MODE);
    }

    return { config: resolved as unknown as AppConfig, origins, fileSecrets };
  });
}

/**
 * Detect the legacy top-level `google` block — an OAuth client id/secret pair
 * that was scaffolded into the config shape but never read by anything.
 *
 * It is matched by shape rather than merely by key, so a `google` block that
 * someone repurposed for something else is left alone.
 */
function dropLegacyGoogleBlock(fileRecord: Record<string, unknown>): boolean {
  const block = fileRecord["google"];
  if (!block || typeof block !== "object") return false;

  const keys = Object.keys(block);
  if (keys.length === 0) return true;
  return keys.every((key) => key === "clientId" || key === "clientSecret");
}

/**
 * Tell the user once, on the run that removes it. The credential is not moved
 * anywhere — nothing ever read it — so silently deleting it would be the wrong
 * kind of quiet.
 */
function noticeLegacyGoogleRemoved(configPath: string): void {
  process.stderr.write(
    `jazz: removed the unused "google" client id/secret block from ${configPath}.\n` +
      `      Nothing in Jazz ever read it. If you still need those values, recover them\n` +
      `      from your version control or backups before they age out.\n`,
  );
}

/**
 * Move secrets still sitting in the global config file into the keyring.
 * Returns the paths that moved, i.e. those now safe to drop from the file.
 */
function migratePlaintextSecrets(
  backend: KeyringBackend,
  fileRecord: Record<string, unknown>,
  candidates: ReadonlySet<string>,
): Effect.Effect<string[], never> {
  return Effect.gen(function* () {
    if (backend === "none") return [];

    const migrated: string[] = [];
    for (const path of candidates) {
      const fileValue = deepGet(fileRecord, path);
      if (!nonEmptyString(fileValue)) continue;

      const stored = yield* keyringSet(backend, path, fileValue);
      if (stored) migrated.push(path);
    }

    return migrated;
  });
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
    return home ? p.replace(/^~/, home) : p;
  }
  return p;
}

function stripStorageOverride(config: Partial<AppConfig>): Partial<AppConfig> {
  const { storage: _storage, ...rest } = config;
  return rest;
}

function readOptionalConfigFile(
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<{ config: Partial<AppConfig>; renamedProvider: boolean } | undefined, never> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return undefined;

    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    if (!content.trim()) return undefined;

    const parsed = safeParseJson<Partial<AppConfig>>(content);
    if (Option.isNone(parsed)) return undefined;

    const config = parsed.value;
    if (typeof config !== "object" || config === null) return undefined;

    const renamedProvider = migrateConfigProviderName(config);
    return { config, renamedProvider };
  });
}

function loadConfigFile(
  fs: FileSystem.FileSystem,
  customConfigPath?: string,
): Effect.Effect<
  {
    configPath?: string;
    fileConfig?: Partial<AppConfig>;
    globalConfig?: Partial<AppConfig>;
    localConfig?: Partial<AppConfig>;
    renamedProvider?: boolean;
  },
  ConfigurationError | ConfigurationNotFoundError
> {
  return Effect.gen(function* () {
    // If custom config path is provided, validate and use it exclusively
    if (customConfigPath) {
      const expandedPath = expandHome(customConfigPath);
      const exists = yield* fs
        .exists(expandedPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (!exists) {
        return yield* Effect.fail(
          new ConfigurationNotFoundError({
            path: expandedPath,
            suggestion: "Please ensure the file exists and the path is correct.",
          }),
        );
      }

      const contentResult = yield* fs.readFileString(expandedPath).pipe(
        Effect.catchAll((error) =>
          Effect.fail(
            new ConfigurationError({
              field: "file",
              message: `Cannot read config file at: ${expandedPath}. Reason: ${String(error)}`,
              suggestion: "Check file permissions and ensure the file is readable.",
            }),
          ),
        ),
      );

      const content = contentResult;

      if (!content) {
        return yield* Effect.fail(
          new ConfigurationError({
            field: "file",
            message: `Config file is empty: ${expandedPath}`,
            suggestion: "Add valid JSON configuration to the file.",
          }),
        );
      }

      const parsed = safeParseJson<Partial<AppConfig>>(content);
      if (Option.isNone(parsed)) {
        return yield* Effect.fail(
          new ConfigurationError({
            field: "format",
            message: `Invalid JSON in config file: ${expandedPath}`,
            suggestion: "Please ensure the file contains valid JSON.",
          }),
        );
      }

      const config = parsed.value;
      if (typeof config !== "object" || config === null) {
        return yield* Effect.fail(
          new ConfigurationError({
            field: "structure",
            message: `Config file must contain a valid configuration object: ${expandedPath}`,
            value: config,
            suggestion: 'Expected format: { "llm": {...}, "storage": {...}, ... }',
          }),
        );
      }

      const renamedProvider = migrateConfigProviderName(config);

      const localConfigPath = `${getLocalJazzDirectory()}/config.json`;
      const localRead = yield* readOptionalConfigFile(fs, localConfigPath);
      const localConfigRaw = localRead?.config;
      const localConfig = localConfigRaw ? stripStorageOverride(localConfigRaw) : undefined;

      const emptyBase = defaultConfig();
      const mergedFromGlobal = mergeConfig(emptyBase, config);
      const merged = localConfig ? mergeConfig(mergedFromGlobal, localConfig) : mergedFromGlobal;

      const result: {
        configPath: string;
        fileConfig: Partial<AppConfig>;
        globalConfig?: Partial<AppConfig>;
        localConfig?: Partial<AppConfig>;
        renamedProvider?: boolean;
      } = {
        configPath: expandedPath,
        fileConfig: merged,
        globalConfig: config,
        renamedProvider,
      };

      if (localConfigRaw) {
        result.localConfig = localConfigRaw;
      }

      return result;
    }

    const envConfigPath = process.env["JAZZ_CONFIG_PATH"];
    const globalConfigPath = envConfigPath
      ? expandHome(envConfigPath)
      : `${getJazzHomeDirectory()}/config.json`;
    const localConfigPath = `${getLocalJazzDirectory()}/config.json`;

    const globalRead = yield* readOptionalConfigFile(fs, globalConfigPath);
    const globalConfig = globalRead?.config;
    const localRead = yield* readOptionalConfigFile(fs, localConfigPath);
    const localConfigRaw = localRead?.config;
    const localConfig = localConfigRaw ? stripStorageOverride(localConfigRaw) : undefined;

    if (!globalConfig && !localConfig) {
      return { configPath: globalConfigPath };
    }

    const emptyBase = defaultConfig();
    const mergedFromGlobal = globalConfig ? mergeConfig(emptyBase, globalConfig) : emptyBase;
    const merged = localConfig ? mergeConfig(mergedFromGlobal, localConfig) : mergedFromGlobal;

    const result: {
      configPath: string;
      fileConfig: Partial<AppConfig>;
      globalConfig?: Partial<AppConfig>;
      localConfig?: Partial<AppConfig>;
      renamedProvider?: boolean;
    } = {
      configPath: globalConfigPath,
      fileConfig: merged,
      renamedProvider: globalRead?.renamedProvider ?? false,
    };

    if (globalConfig) {
      result.globalConfig = globalConfig;
    }
    if (localConfigRaw) {
      result.localConfig = localConfigRaw;
    }

    return result;
  });
}

/**
 * Load full MCP server configs from .agents/mcp.json files.
 * These are the source of truth for server definitions (command, args, env, etc.).
 * Merge order: user ~/.agents/mcp.json first, then project .agents/mcp.json (project overrides).
 *
 * Returns a flat record of server name -> full MCPServerConfig.
 */
function loadAgentsMcpServers(
  fs: FileSystem.FileSystem,
): Effect.Effect<Record<string, MCPServerConfig>, never> {
  return Effect.gen(function* () {
    const candidates: readonly string[] = [
      `${expandHome("~/.agents")}/mcp.json`,
      `${process.cwd()}/.agents/mcp.json`,
    ];

    const merged: Record<string, unknown> = {};

    for (const filePath of candidates) {
      const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!exists) continue;

      const content = yield* fs
        .readFileString(filePath)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      if (!content.trim()) continue;

      const parsed = safeParseJson<unknown>(content);
      if (Option.isNone(parsed)) continue;

      const parsedValue = parsed.value;
      if (typeof parsedValue !== "object" || parsedValue === null) continue;

      // Support both { "mcpServers": {...} } wrapper and direct { "serverName": {...} }.
      // When using the direct format, all top-level keys are treated as server names.
      // Use the wrapped format to avoid ambiguity with non-server keys (e.g. "$schema").
      const record = parsedValue as Record<string, unknown>;
      const servers =
        "mcpServers" in record && typeof record["mcpServers"] === "object"
          ? (record["mcpServers"] as Record<string, unknown>)
          : record;

      for (const [name, cfg] of Object.entries(servers)) {
        // Only include entries that look like server configs (must be objects)
        if (cfg && typeof cfg === "object") {
          merged[name] = cfg;
        }
      }
    }

    return merged as Record<string, MCPServerConfig>;
  });
}

function extractMcpOverridesFromFile(
  mcpServers: Record<string, unknown> | undefined,
): Record<string, MCPServerOverride> {
  if (!mcpServers || typeof mcpServers !== "object") return {};
  const out: Record<string, MCPServerOverride> = {};
  for (const [name, entry] of Object.entries(mcpServers)) {
    const ov = extractMcpOverride(entry);
    if (ov) out[name] = ov;
  }
  return out;
}

/**
 * Merge full MCP server definitions from .agents/mcp.json with
 * enable/disable overrides from ~/.jazz/config.json, returning an updated AppConfig.
 */
function mergeAgentsMcpIntoConfig(
  config: AppConfig,
  agentsServers: Record<string, MCPServerConfig>,
  overrides: Record<string, MCPServerOverride>,
): AppConfig {
  if (Object.keys(agentsServers).length === 0) return config;
  return {
    ...config,
    mcpServers: mergeMcpServers(agentsServers, overrides),
  };
}

/**
 * Write MCP server configurations to ~/.agents/mcp.json.
 *
 * Reads the existing file (if any), merges in the new servers, and writes back.
 * Creates the ~/.agents directory if it doesn't exist.
 */
export function writeAgentsMcpServer(
  fs: FileSystem.FileSystem,
  name: string,
  config: Record<string, unknown>,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const filePath = `${expandHome("~/.agents")}/mcp.json`;
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));

    // Ensure ~/.agents directory exists
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));

    // Read existing content
    let existing: Record<string, unknown> = {};
    const fileExists = yield* fs
      .exists(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));

    if (fileExists) {
      const content = yield* fs
        .readFileString(filePath)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      if (content.trim()) {
        const parsed = safeParseJson<unknown>(content);
        if (Option.isSome(parsed) && typeof parsed.value === "object" && parsed.value !== null) {
          const record = parsed.value as Record<string, unknown>;
          // Support wrapped format
          if ("mcpServers" in record && typeof record["mcpServers"] === "object") {
            existing = record["mcpServers"] as Record<string, unknown>;
          } else {
            existing = record;
          }
        }
      }
    }

    // Merge and write back (always use wrapped format)
    const updated = { ...existing, [name]: config };
    const output = JSON.stringify({ mcpServers: updated }, null, 2);
    yield* fs.writeFileString(filePath, output).pipe(Effect.catchAll(() => Effect.void));
  });
}

/**
 * Remove an MCP server from ~/.agents/mcp.json.
 */
export function removeAgentsMcpServer(
  fs: FileSystem.FileSystem,
  name: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const filePath = `${expandHome("~/.agents")}/mcp.json`;
    const fileExists = yield* fs
      .exists(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));

    if (!fileExists) return;

    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    if (!content.trim()) return;

    const parsed = safeParseJson<unknown>(content);
    if (Option.isNone(parsed) || typeof parsed.value !== "object" || parsed.value === null) return;

    const record = parsed.value as Record<string, unknown>;
    let servers: Record<string, unknown>;

    if ("mcpServers" in record && typeof record["mcpServers"] === "object") {
      servers = { ...(record["mcpServers"] as Record<string, unknown>) };
    } else {
      servers = { ...record };
    }

    delete servers[name];
    const output = JSON.stringify({ mcpServers: servers }, null, 2);
    yield* fs.writeFileString(filePath, output).pipe(Effect.catchAll(() => Effect.void));
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
/**
 * Removes the value at a dot notation path, then discards any parent objects
 * the removal emptied — so dropping `llm.openai.api_key` does not leave an
 * orphaned `llm.openai: {}` behind in the written config.
 */
function deepDelete(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;

  const chain: Record<string, unknown>[] = [obj];
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i] as string];
    if (!next || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
    chain.push(cur);
  }

  delete cur[parts[parts.length - 1] as string];

  for (let i = chain.length - 1; i > 0; i--) {
    const node = chain[i] as Record<string, unknown>;
    if (Object.keys(node).length > 0) break;
    delete (chain[i - 1] as Record<string, unknown>)[parts[i - 1] as string];
  }
}

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
        cur[key] = {};
      }
      cur = cur[key] as Record<string, unknown>;
    }
  }
}
