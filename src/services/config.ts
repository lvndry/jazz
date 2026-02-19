import { FileSystem } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import { ConfigurationError, ConfigurationNotFoundError } from "@/core/types/errors";
import type {
  AppConfig,
  GoogleConfig,
  LLMConfig,
  LoggingConfig,
  MCPServerOverride,
  StorageConfig,
  WebSearchConfig,
} from "@/core/types/index";
import { safeParseJson } from "@/core/utils/json";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";

/**
 * Extract only override fields (enabled) from a server config.
 * Used when persisting to jazz.config.json — full definitions live in mcp.json.
 */
function extractMcpOverride(entry: unknown): MCPServerOverride | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const obj = entry as Record<string, unknown>;
  if (typeof obj["enabled"] !== "boolean") return undefined;
  return { enabled: obj["enabled"] } as MCPServerOverride;
}

/**
 * Build jazz config for persistence: full config but mcpServers replaced by overrides only.
 */
function buildJazzConfigForPersist(
  config: AppConfig,
  mcpOverrides: Record<string, MCPServerOverride>,
): Record<string, unknown> {
  const json = config as unknown as Record<string, unknown>;
  const out = { ...json };
  out["mcpServers"] = Object.keys(mcpOverrides).length > 0 ? mcpOverrides : undefined;
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

  constructor(
    initialConfig: AppConfig,
    mcpOverrides: Record<string, MCPServerOverride>,
    configPath: string | undefined,
    fs: FileSystem.FileSystem,
  ) {
    this.currentConfig = initialConfig;
    this.mcpOverrides = mcpOverrides;
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
        const keyLower = key;

        if (keyLower === "mcpServers") {
          // Bulk replace overrides (e.g. from remove command)
          const val = value as unknown as Record<string, unknown>;
          this.mcpOverrides = Object.fromEntries(
            Object.entries(val ?? {})
              .map(([k, v]) => [k, extractMcpOverride(v)])
              .filter((entry): entry is [string, MCPServerOverride] => entry[1] !== undefined),
          );
          const agentsServers = yield* loadAgentsMcpServers(this.fs);
          const merged = mergeMcpServers(agentsServers, this.mcpOverrides);
          this.currentConfig = {
            ...this.currentConfig,
            mcpServers: merged as unknown as Record<string, MCPServerOverride>,
          };
        } else if (keyLower.startsWith("mcpServers.")) {
          const rest = keyLower.slice("mcpServers.".length);
          const parts = rest.split(".");
          const serverName = parts[0];
          if (!serverName) return;

          if (parts.length === 1) {
            // set("mcpServers.X", { enabled: true }) — merge override
            const val = value as unknown as Record<string, unknown>;
            const next = extractMcpOverride(val) ?? {};
            this.mcpOverrides[serverName] = {
              ...this.mcpOverrides[serverName],
              ...next,
            };
            const cfg = this.currentConfig.mcpServers?.[serverName] as
              | Record<string, unknown>
              | undefined;
            deepSet(this.currentConfig as unknown as Record<string, unknown>, keyLower, {
              ...cfg,
              ...val,
            } as unknown);
          } else {
            // set("mcpServers.X.enabled", value)
            const prop = parts[1];
            if (prop === "enabled") {
              this.mcpOverrides[serverName] = {
                ...this.mcpOverrides[serverName],
                enabled: value as boolean,
              };
            }
            deepSet(
              this.currentConfig as unknown as Record<string, unknown>,
              keyLower,
              value as unknown,
            );
          }
        } else {
          deepSet(
            this.currentConfig as unknown as Record<string, unknown>,
            keyLower,
            value as unknown,
          );
        }

        const path = this.configPath ?? `${expandHome("~/.jazz")}/config.json`;
        if (!this.configPath) {
          this.configPath = path;
          const dir = path.substring(0, path.lastIndexOf("/"));
          yield* this.fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.catchAll(() => Effect.void));
        }

        const toWrite = buildJazzConfigForPersist(this.currentConfig, this.mcpOverrides);
        yield* this.fs
          .writeFileString(path, JSON.stringify(toWrite, null, 2))
          .pipe(Effect.catchAll(() => Effect.void));
      }.bind(this),
    ).pipe(Effect.catchAll(() => Effect.void));
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
    } as MCPServerConfig;
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
          } as Partial<AppConfig>)
        : mergeConfig(baseConfig, fileConfigWithoutMcp);

      // Load MCP definitions from .agents/mcp.json
      const agentsServers = yield* loadAgentsMcpServers(fs);

      // Extract overrides from jazz (enabled only)
      const mcpOverrides = extractMcpOverridesFromFile(fileConfig?.mcpServers);

      const finalConfig = mergeAgentsMcpIntoConfig(mainConfig, agentsServers, mcpOverrides);

      return new AgentConfigServiceImpl(finalConfig, mcpOverrides, loaded.configPath, fs);
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
  const storage: StorageConfig = { type: "file", path: getUserDataDirectory() };
  const logging: LoggingConfig = {
    level: "info",
    format: "plain",
  };

  const google: GoogleConfig = {
    clientId: "",
    clientSecret: "",
  };

  const llm: LLMConfig = {};
  const web_search: WebSearchConfig = {};

  return { storage, logging, google, llm, web_search };
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
    ...(override.google && { google: { ...base.google, ...override.google } }),
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

      // Validate that the parsed config matches AppConfig structure
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

    let merged: Record<string, unknown> = {};

    for (const filePath of candidates) {
      const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!exists) continue;

      const content = yield* fs
        .readFileString(filePath)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      if (!content.trim()) continue;

      const parsed = safeParseJson<unknown>(content);
      if (Option.isNone(parsed)) continue;

      const obj = parsed.value;
      if (typeof obj !== "object" || obj === null) continue;

      // Support both { "mcpServers": {...} } and direct { "serverName": {...} }
      const record = obj as Record<string, unknown>;
      const servers =
        "mcpServers" in record && typeof record["mcpServers"] === "object"
          ? (record["mcpServers"] as Record<string, unknown>)
          : obj;

      if (servers && typeof servers === "object") {
        merged = { ...merged, ...servers };
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
 * enable/disable overrides from jazz.config.json.
 */
function mergeAgentsMcpIntoConfig(
  config: AppConfig,
  agentsServers: Record<string, MCPServerConfig>,
  overrides: Record<string, MCPServerOverride>,
): AppConfig {
  if (Object.keys(agentsServers).length === 0) return config;

  const merged: Record<string, MCPServerConfig> = {};
  for (const [name, serverConfig] of Object.entries(agentsServers)) {
    const ov = overrides[name];
    merged[name] = {
      ...serverConfig,
      ...(ov?.enabled !== undefined ? { enabled: ov.enabled } : {}),
    } as MCPServerConfig;
  }

  return {
    ...config,
    mcpServers: merged as unknown as Record<string, MCPServerOverride>,
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
