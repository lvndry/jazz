/**
 * Implements `AgentConfigService`: reads/writes `~/.jazz/config.json`, resolving secrets from
 * env vars, the OS keyring, or the file itself (see `core/secrets/registry`) without ever
 * persisting a secret that came from somewhere other than the file back into it.
 *
 * Loading checks the global file and any project `./.jazz/config.json` against
 * `ConfigFileSchema` before either can affect runtime behavior. Initial loads report and isolate
 * invalid values so unattended work can continue; live reloads retain the last-known-good
 * configuration until an edited file is valid again.
 *
 * Writing edits the global file as it was read, never the merged runtime view. Nothing from the
 * defaults, a project override, `--debug`, the environment or the keyring can reach the file
 * through `set`, and entries Jazz does not understand are left in place rather than deleted.
 */

import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { MCPServerConfig, MCPServerDefinitionSource } from "@jazz/core/interfaces/mcp-server";
import { collectKnownSecrets, type KnownSecret } from "@jazz/core/secrets/redaction";
import {
  SECRET_PATHS,
  heldSecretPaths,
  isSecretPath,
  mcpServerSecretPath,
  type McpServerSecretField,
  runtimeSecretPaths,
  secretValueFromEnv,
} from "@jazz/core/secrets/registry";
import { ConfigurationError, ConfigurationNotFoundError } from "@jazz/core/types/errors";
import type {
  AppConfig,
  LLMConfig,
  LoggingConfig,
  MCPServerOverride,
  StorageConfig,
  WebSearchConfig,
} from "@jazz/core/types/index";
import { splitConfigPath } from "@jazz/core/utils/config-path";
import {
  checkConfigWrite,
  formatConfigIssues,
  mcpServerEntryName,
  missingNamedListEntry,
  namedListEntryOf,
  parseConfigFile,
  type ConfigFile,
  validateEffectiveConfig,
} from "@jazz/core/utils/config-schema";
import { toError } from "@jazz/core/utils/errors";
import { acquireFileLock } from "@jazz/core/utils/file-lock";
import { isRecord } from "@jazz/core/utils/is-record";
import { safeParseJson } from "@jazz/core/utils/json";
import {
  getGlobalUserDataDirectory,
  getGlobalConfigFilePath,
  getLocalJazzDirectory,
} from "@jazz/core/utils/paths";
import { stateDirectoryMode } from "@jazz/core/utils/private-mode";
import {
  migrateConfigProviderName,
  migrateKeyringProviderName,
} from "@jazz/core/utils/provider-migration";
import { resolveStorageDirectory, withLock, writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect, Layer, Option } from "effect";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringSet,
  type KeyringBackend,
} from "./secrets/keyring";

/**
 * ~/.jazz/config.json can hold API keys, so it is created private to the user
 * and repaired on load — a default umask would otherwise leave it world-readable.
 */
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

/** A config file as parsed from JSON, before any checking: the shape `set` edits and writes back. */
type ConfigDocument = Record<string, unknown>;

/**
 * How long the known secrets are reused before the keyring is read again, so a token another
 * process stores (`jazz peers add` in a second terminal) is withheld within a minute.
 */
const KNOWN_SECRETS_TTL_MS = 60_000;

/** Where `storeSecret` put a secret, which decides what the config file keeps of it. */
type SecretDestination = "keyring" | "file" | "cleared" | "nowhere";

const EMPTY_CONFIG_FILE: ConfigFile = {};

/** The independently owned layers needed to rebuild the effective runtime configuration. */
interface RuntimeConfigSources {
  readonly defaults: AppConfig;
  global: ConfigFile;
  readonly local: ConfigFile;
  readonly debug: boolean;
  readonly agentsServers: Record<string, MCPServerConfig>;
  readonly resolvedSecrets: Map<string, string>;
}

/**
 * Configuration service over the merged runtime view, persisting to the global config file.
 */
export class AgentConfigServiceImpl implements AgentConfigService {
  private currentConfig: AppConfig;
  /**
   * The global config file as it stands on disk, and the only thing `set` writes. Keeping it
   * apart from `currentConfig` is what stops a write copying merged-in values into the file.
   */
  private fileDocument: ConfigDocument;
  private configPath: string | undefined;
  private fs: FileSystem.FileSystem;
  private currentRevision: number;
  /** When config.json was last read, so an external edit can be noticed. */
  private loadedAt: number | undefined;
  private keyringBackend: KeyringBackend;
  private readonly sources: RuntimeConfigSources | undefined;
  /**
   * Secrets that could not be stored anywhere: no keyring, and no structural home in the
   * config file. Tracked so a command can report the failure instead of claiming success.
   */
  private readonly unstorableSecrets = new Set<string>();
  private knownSecretsCache:
    | {
        readonly revision: number;
        readonly resolvedAtMs: number;
        readonly secrets: readonly KnownSecret[];
      }
    | undefined;

  constructor(
    initialConfig: AppConfig,
    fileDocument: ConfigDocument,
    configPath: string | undefined,
    fs: FileSystem.FileSystem,
    keyringBackend: KeyringBackend = "none",
    sources?: RuntimeConfigSources,
  ) {
    this.currentConfig = initialConfig;
    this.fileDocument = fileDocument;
    this.configPath = configPath;
    this.fs = fs;
    this.currentRevision = 0;
    this.keyringBackend = keyringBackend;
    this.sources = sources;
  }

  get<A>(key: string): Effect.Effect<A, never> {
    return Effect.sync(() => deepGet(this.currentConfig, key) as A);
  }

  getOrElse<A>(key: string, fallback: A): Effect.Effect<A, never> {
    return Effect.sync(() => {
      const value = deepGet(this.currentConfig, key);
      return value === undefined || value === null ? fallback : (value as A);
    });
  }

  getOrFail<A>(key: string): Effect.Effect<A, never> {
    return Effect.sync(() => deepGet(this.currentConfig, key) as A);
  }

  has(key: string): Effect.Effect<boolean, never> {
    return Effect.sync(() => {
      const value = deepGet(this.currentConfig, key);
      if (typeof value === "string") return value.trim().length > 0;
      return value !== undefined && value !== null;
    });
  }

  secretStorageUnavailable(key: string): boolean {
    return this.unstorableSecrets.has(key);
  }

  /**
   * Write one config value to the runtime view and to the global config file.
   *
   * A non-secret value is checked against the config schema first. Every caller hands over an
   * already-typed value, so one that does not fit is a bug in Jazz rather than bad input, and it
   * dies instead of being written as a setting nothing will ever read. `jazz config set`, which
   * does take input, converts and refuses values before they get here.
   *
   * Secrets are trimmed (a pasted key often ends in a newline) and routed to the keyring when one
   * is usable. A secret whose root names a list has no structural home at all, and clearing any
   * value is a delete rather than an assignment, so no empty parent objects are left behind in the
   * file.
   */
  set<A>(key: string, rawValue: A): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        const secret = isSecretPath(key);
        const value = secret && typeof rawValue === "string" ? rawValue.trim() : rawValue;
        if (!secret) {
          const check = checkConfigWrite(key, value);
          if (!check.ok) {
            return yield* Effect.die(new Error(`Refusing to write config: ${check.problem}`));
          }
        }

        const path = this.configPath ?? getGlobalConfigFilePath();
        if (!this.configPath) {
          this.configPath = path;
          const dir = path.substring(0, path.lastIndexOf("/"));
          yield* this.fs
            .makeDirectory(dir, { recursive: true, mode: CONFIG_DIR_MODE })
            .pipe(Effect.catchAll(() => Effect.void));
        }

        yield* withLock(`${path}.lock`, this.writeValueLocked(path, key, value, secret)).pipe(
          Effect.provideService(FileSystem.FileSystem, this.fs),
          Effect.orDie,
        );
      }.bind(this),
    ).pipe(Effect.catchAll(() => Effect.void));
  }

  /** Re-read, patch, validate, atomically persist, then commit the new in-memory view. */
  private writeValueLocked(
    path: string,
    key: string,
    value: unknown,
    secret: boolean,
  ): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        const latestDocument =
          this.sources === undefined
            ? this.fileDocument
            : yield* readConfigDocumentForWrite(this.fs, path);
        const nextDocument = structuredClone(latestDocument);

        const nextResolvedSecrets =
          this.sources === undefined ? undefined : new Map(this.sources.resolvedSecrets);

        if (secret) {
          const destination = yield* this.storeSecret(key, value);
          if (destination === "file") deepSet(nextDocument, key, value);
          else if (destination !== "nowhere") deepDelete(nextDocument, key);
          if (destination === "file" || destination === "keyring") {
            nextResolvedSecrets?.set(key, value as string);
          } else if (destination === "cleared") {
            nextResolvedSecrets?.delete(key);
          }
        } else {
          writeToDocument(nextDocument, key, value);
        }

        const checked = parseCheckedConfigFile(path, nextDocument);
        if (checked.report !== undefined) {
          process.stderr.write(
            `${checked.report.trimEnd()}\njazz: not saving ${key}: ${path} would no longer be valid.\n`,
          );
          return;
        }

        const nextRuntime =
          this.sources === undefined
            ? undefined
            : buildRuntimeConfig({
                ...this.sources,
                global: checked.config,
                resolvedSecrets: nextResolvedSecrets ?? new Map<string, string>(),
              });
        const effectiveRuntime =
          nextRuntime === undefined ? undefined : sanitizeEffectiveConfig(nextRuntime);

        yield* writePrivateFile(path, JSON.stringify(nextDocument, null, 2));
        this.fileDocument = nextDocument;
        if (this.sources === undefined) {
          this.applyToRuntime(key, value, secret);
        } else {
          this.sources.resolvedSecrets.clear();
          for (const [secretPath, secretValue] of nextResolvedSecrets ?? []) {
            this.sources.resolvedSecrets.set(secretPath, secretValue);
          }
          this.sources.global = checked.config;
          this.currentConfig = effectiveRuntime as AppConfig;
        }
        this.currentRevision += 1;
      }.bind(this),
    );
  }

  /** Mirror a write into the merged runtime view, so readers see it without a reload. */
  private applyToRuntime(key: string, value: unknown, secret: boolean): void {
    const runtime = this.currentConfig as unknown as ConfigDocument;
    if (secret && !structuralHomeFor(this.currentConfig, key)) return;
    const mcpName = mcpServerEntryName(key, value);
    if (mcpName !== undefined) {
      patchMcpServerEntry(runtime, mcpName, value);
      return;
    }
    if (value === undefined || (secret && isBlankSecret(value))) {
      deepDelete(runtime, key);
      return;
    }
    deepSet(runtime, key, value);
  }

  /**
   * Route a secret to the keyring when one is usable, and say where it went so the file keeps
   * exactly what it should. Falls through to file storage (mode 0600) when there is no keyring.
   *
   * A secret with no structural home cannot use that fallback — JSON.stringify would discard
   * it — so it is left unstored and reported through `secretStorageUnavailable` rather than
   * silently lost. So is a secret for a list entry that does not exist (a notify target, a
   * webhook or a peer not configured), which would belong to nothing.
   */
  private storeSecret(key: string, value: unknown): Effect.Effect<SecretDestination, never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        if (typeof value !== "string" || value.trim() === "") {
          yield* keyringDelete(this.keyringBackend, key);
          return "cleared" as const;
        }

        if (missingNamedListEntry(this.currentConfig, key) !== undefined) {
          this.unstorableSecrets.add(key);
          return "nowhere" as const;
        }

        const stored = yield* keyringSet(this.keyringBackend, key, value);
        if (stored) return "keyring" as const;

        if (structuralHomeFor(this.currentConfig, key)) return "file" as const;
        this.unstorableSecrets.add(key);
        return "nowhere" as const;
      }.bind(this),
    );
  }

  get revision(): Effect.Effect<number, never> {
    return Effect.succeed(this.currentRevision);
  }

  get appConfig(): Effect.Effect<AppConfig, never> {
    return Effect.succeed(this.currentConfig);
  }

  /**
   * Every secret Jazz holds, resolved once per config revision and at most every
   * {@link KNOWN_SECRETS_TTL_MS}, so redacting a tool result does not read the keyring each time.
   */
  get knownSecrets(): Effect.Effect<readonly KnownSecret[], never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        const now = Date.now();
        const cached = this.knownSecretsCache;
        if (
          cached !== undefined &&
          cached.revision === this.currentRevision &&
          now - cached.resolvedAtMs < KNOWN_SECRETS_TTL_MS
        ) {
          return cached.secrets;
        }
        const revision = this.currentRevision;
        const config = this.currentConfig;
        const backend = this.keyringBackend;
        const held = yield* resolveHeldSecrets(config, (path) => keyringGet(backend, path));
        const secrets = collectKnownSecrets(config, process.env, held);
        this.knownSecretsCache = { revision, resolvedAtMs: now, secrets };
        return secrets;
      }.bind(this),
    );
  }

  /**
   * Re-read config.json when its mtime has moved, returning whether anything changed.
   *
   * `appConfig` answers from memory, so a caller that must see an edit made by another
   * process asks for this first. Takes `webhooks` and `peers`, checked like any load; secrets
   * stay in the keyring. The file document is replaced too, so a later `set` keeps that edit.
   */
  reloadIfChanged(): Effect.Effect<boolean, never> {
    return Effect.gen(
      function* (this: AgentConfigServiceImpl) {
        const path = this.configPath;
        if (path === undefined) return false;

        const stat = yield* this.fs
          .stat(path)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        const modified = stat?.mtime;
        const at = Option.isOption(modified)
          ? Option.getOrUndefined(modified)?.getTime()
          : undefined;
        if (at === undefined || at === this.loadedAt) return false;
        this.loadedAt = at;

        const content = yield* this.fs
          .readFileString(path)
          .pipe(Effect.catchAll(() => Effect.succeed("")));
        const document = parseConfigDocument(content);
        if (document === undefined) {
          process.stderr.write(
            `jazz: invalid configuration in ${path}: expected a JSON object.\n` +
              "jazz: keeping the last-known-good configuration until the file is fixed.\n",
          );
          return false;
        }

        migrateConfigProviderName(document);
        const checked = parseCheckedConfigFile(path, document);
        if (checked.report !== undefined) {
          process.stderr.write(
            `${checked.report.trimEnd()}\n` +
              "jazz: keeping the last-known-good configuration until the file is fixed.\n",
          );
          return false;
        }
        if (this.sources === undefined) {
          const fromFile = checked.config;
          this.currentConfig = {
            ...this.currentConfig,
            ...(fromFile.webhooks !== undefined ? { webhooks: fromFile.webhooks } : {}),
            ...(fromFile.peers !== undefined ? { peers: fromFile.peers } : {}),
            ...(fromFile.hosts !== undefined ? { hosts: fromFile.hosts } : {}),
          };
        } else {
          const nextRuntime = buildRuntimeConfig({ ...this.sources, global: checked.config });
          const report = effectiveConfigReport(nextRuntime);
          if (report !== undefined) {
            process.stderr.write(
              `${report.trimEnd()}\n` +
                "jazz: keeping the last-known-good configuration until the file is fixed.\n",
            );
            return false;
          }
          this.sources.global = checked.config;
          this.currentConfig = nextRuntime;
        }
        this.fileDocument = document;
        this.currentRevision += 1;
        return true;
      }.bind(this),
    ).pipe(Effect.catchAll(() => Effect.succeed(false)));
  }
}

function mergedEntry(existing: unknown, patch: unknown): ConfigDocument {
  return { ...(isRecord(existing) ? existing : {}), ...(isRecord(patch) ? patch : {}) };
}

/**
 * Patch `mcpServers.<name>` at its literal key, merging into that server's existing entry.
 *
 * The name is a record key, not a dotted path, so a server named `com.example.mcp` is one key
 * rather than a nested object — `deepSet` on the dotted form would both misplace it and, before
 * the schema check reached here, reject it outright.
 */
function patchMcpServerEntry(target: ConfigDocument, name: string, patch: unknown): void {
  const servers = isRecord(target["mcpServers"]) ? target["mcpServers"] : {};
  target["mcpServers"] = { ...servers, [name]: structuredClone(mergedEntry(servers[name], patch)) };
}

/** Apply a checked, non-secret write to the file document. */
function writeToDocument(document: ConfigDocument, key: string, value: unknown): void {
  const mcpName = mcpServerEntryName(key, value);
  if (mcpName !== undefined) {
    patchMcpServerEntry(document, mcpName, value);
    return;
  }
  if (value === undefined) {
    deepDelete(document, key);
    return;
  }
  deepSet(document, key, structuredClone(value));
}

/** Parse a config file's text into a document, or `undefined` when it is not a JSON object. */
function parseConfigDocument(content: string): ConfigDocument | undefined {
  const parsed = safeParseJson<unknown>(content);
  if (Option.isNone(parsed)) return undefined;
  return isRecord(parsed.value) ? parsed.value : undefined;
}

/**
 * Re-read the global file immediately before a mutation. This is Pi's useful invariant: a write
 * patches the latest document, not the snapshot from process startup. Malformed JSON is never
 * replaced. Schema-invalid entries remain byte-for-byte present unless the requested write targets
 * them, while the runtime view continues to ignore them.
 */
function readConfigDocumentForWrite(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<ConfigDocument, never> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(path).pipe(Effect.orDie);
    if (!exists) return {};
    const content = yield* fs.readFileString(path).pipe(Effect.orDie);
    const document = parseConfigDocument(content);
    if (document === undefined) {
      return yield* Effect.die(
        new Error(`Refusing to overwrite ${path}: it is not a valid JSON object.`),
      );
    }
    migrateConfigProviderName(document);
    return document;
  });
}

/**
 * Check one config file against the schema, reporting on stderr what was dropped.
 *
 * A legacy `google` block is left to `resolveSecrets`, which removes it with its own notice, so it
 * is not reported a second time here as an unknown key.
 */
function parseCheckedConfigFile(
  path: string,
  document: ConfigDocument,
): { readonly config: ConfigFile; readonly report?: string } {
  const { google: _legacyGoogle, ...withoutGoogle } = document;
  const { config, issues } = parseConfigFile(
    dropLegacyGoogleBlock(document) ? withoutGoogle : document,
  );
  const report = formatConfigIssues(path, issues, isSecretPath);
  return report === undefined ? { config } : { config, report };
}

/** Validate an initial config load. Invalid files stop startup instead of removing safety limits. */
function requireValidConfigFile(
  path: string,
  document: ConfigDocument,
): Effect.Effect<ConfigFile, ConfigurationError> {
  const checked = parseCheckedConfigFile(path, document);
  if (checked.report === undefined) return Effect.succeed(checked.config);
  return Effect.fail(
    new ConfigurationError({
      field: "file",
      message: checked.report.trimEnd(),
      suggestion: `Fix ${path} and restart Jazz.`,
    }),
  );
}

function effectiveConfigReport(config: AppConfig): string | undefined {
  return formatConfigIssues(
    "the merged configuration",
    validateEffectiveConfig(config),
    isSecretPath,
  );
}

/** Remove invalid cross-layer values from the runtime view after reporting them. */
function sanitizeEffectiveConfig(config: AppConfig): AppConfig {
  const issues = validateEffectiveConfig(config);
  if (issues.length === 0) return config;
  const report = formatConfigIssues("the merged configuration", issues, isSecretPath);
  if (report !== undefined) process.stderr.write(report);
  const sanitized = structuredClone(config) as unknown as ConfigDocument;
  for (const issue of issues) deepDelete(sanitized, issue.removed);
  return sanitized as unknown as AppConfig;
}

function requireValidEffectiveConfig(
  config: AppConfig,
): Effect.Effect<AppConfig, ConfigurationError> {
  const report = effectiveConfigReport(config);
  return report === undefined
    ? Effect.succeed(config)
    : Effect.fail(
        new ConfigurationError({
          field: "context",
          message: report.trimEnd(),
          suggestion: "Adjust the global or project override so warning precedes compaction.",
        }),
      );
}

/**
 * Lay Jazz's per-server overrides over the `mcp.json` definitions.
 *
 * `enabled` may come from the global or the project config file, the project winning. `trusted`
 * comes only from the global file and applies only to a definition from the user's own
 * `~/.agents/mcp.json`: trust is the user's statement about a server they defined, so a cloned
 * repository can neither declare it nor inherit it by reusing a trusted server's name.
 */
function mergeMcpServers(
  agents: Record<string, MCPServerConfig>,
  globalOverrides: Record<string, MCPServerOverride>,
  localOverrides: Record<string, MCPServerOverride>,
): Record<string, MCPServerConfig> {
  const merged: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(agents)) {
    const enabled = localOverrides[name]?.enabled ?? globalOverrides[name]?.enabled;
    const trusted = cfg.definedIn === "user" ? globalOverrides[name]?.trusted : undefined;
    merged[name] = {
      ...cfg,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(trusted !== undefined ? { trusted } : {}),
    };
  }
  return merged;
}

/**
 * The project config without its `network` section. Which private hosts agents may reach is the
 * user's call, so a config file that came with a cloned repository cannot widen it.
 */
function withoutProjectNetwork(localPath: string, local: ConfigFile): ConfigFile {
  if (local.network === undefined) {
    return local;
  }
  process.stderr.write(
    `jazz: ignoring network in ${localPath}. Only your global config lists private hosts; ` +
      "edit them with jazz > Update configuration > Private network hosts.\n",
  );
  const { network: _network, ...rest } = local;
  return rest;
}

/** Tell the user a project config tried to set MCP trust, which only the global config can. */
function noticeIgnoredProjectTrust(
  localPath: string,
  localOverrides: Record<string, MCPServerOverride>,
): void {
  for (const [name, override] of Object.entries(localOverrides)) {
    if (override.trusted === undefined) {
      continue;
    }
    process.stderr.write(
      `jazz: ignoring mcpServers.${name}.trusted in ${localPath}. Only your global config ` +
        `sets MCP trust; run \`jazz mcp trust ${name}\` to trust a server you defined.\n`,
    );
  }
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
      const files = yield* loadConfigFiles(fs, customConfigPath);

      const checkedGlobal =
        files.global === undefined
          ? EMPTY_CONFIG_FILE
          : yield* requireValidConfigFile(files.global.path, files.global.document);
      const checkedLocal =
        files.local === undefined
          ? EMPTY_CONFIG_FILE
          : withoutProjectNetwork(
              files.local.path,
              yield* requireValidConfigFile(files.local.path, files.local.document),
            );
      const { mcpServers: globalOverrides, ...globalSettings } = checkedGlobal;
      const { mcpServers: localOverrides, ...localSettings } = checkedLocal;

      const mainConfig = mergeConfigLayers(defaultConfig(), [
        globalSettings,
        localSettings,
        ...(debug ? [{ logging: { level: "debug" } }] : []),
      ]);

      if (files.local !== undefined && localOverrides !== undefined) {
        noticeIgnoredProjectTrust(files.local.path, localOverrides);
      }
      const keyringBackend = yield* detectKeyringBackend();
      const agentsServers = yield* loadAgentsMcpServers(fs, keyringBackend);
      const finalConfig = mergeAgentsMcpIntoConfig(
        mainConfig,
        agentsServers,
        globalOverrides ?? {},
        localOverrides ?? {},
      );

      const secrets = yield* resolveSecrets(
        fs,
        finalConfig,
        files.configPath,
        files.global,
        keyringBackend,
      );

      const persistedGlobal = parseCheckedConfigFile(files.configPath, secrets.document).config;
      const sources: RuntimeConfigSources = {
        defaults: baseConfigForRuntime(),
        global: persistedGlobal,
        local: checkedLocal,
        debug: debug === true,
        agentsServers,
        resolvedSecrets: snapshotResolvedSecrets(secrets.config),
      };

      const runtimeConfig = yield* requireValidEffectiveConfig(buildRuntimeConfig(sources));

      return new AgentConfigServiceImpl(
        runtimeConfig,
        secrets.document,
        files.configPath,
        fs,
        keyringBackend,
        sources,
      );
    }),
  );
}

export interface ConfigValidationResult {
  readonly paths: readonly string[];
  /** Where agent files live under the validated configuration. */
  readonly storageDirectory: string;
}

/**
 * Validate configuration without constructing the application layer.
 *
 * This is deliberately independent of keyring, provider, telemetry, and agent startup so a
 * broken file cannot prevent the recovery command that explains how to repair it.
 */
export function validateConfigFiles(
  customConfigPath?: string,
): Effect.Effect<
  ConfigValidationResult,
  ConfigurationError | ConfigurationNotFoundError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* loadConfigFiles(fs, customConfigPath);
    const global =
      files.global === undefined
        ? EMPTY_CONFIG_FILE
        : yield* requireValidConfigFile(files.global.path, files.global.document);
    const local =
      files.local === undefined
        ? EMPTY_CONFIG_FILE
        : yield* requireValidConfigFile(files.local.path, files.local.document);
    const { mcpServers: _globalMcp, ...globalSettings } = global;
    const { mcpServers: _localMcp, ...localSettings } = local;
    const merged = yield* requireValidEffectiveConfig(
      mergeConfigLayers(defaultConfig(), [globalSettings, localSettings]),
    );
    return {
      storageDirectory: resolveStorageDirectory(merged.storage),
      paths: [files.global?.path, files.local?.path].filter(
        (path): path is string => path !== undefined,
      ),
    };
  });
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

/** Named wrapper used when a fresh independent default layer is required. */
function baseConfigForRuntime(): AppConfig {
  return defaultConfig();
}

/**
 * Lay checked config files over the defaults, later layers winning.
 *
 * Objects merge key by key at every depth, so a project file setting `llm.ollama.keep_alive`
 * keeps the global `llm.ollama.base_url`. Lists and single values replace whole: `peers` and
 * `webhooks` are keyed by name, and merging them element-wise would make removing one from a
 * project override impossible.
 */
function mergeConfigLayers(base: AppConfig, layers: readonly object[]): AppConfig {
  let merged = base as unknown as ConfigDocument;
  for (const layer of layers) {
    merged = mergeInto(merged, layer);
  }
  return merged as unknown as AppConfig;
}

function mergeInto(base: Readonly<ConfigDocument>, layer: object): ConfigDocument {
  const out: ConfigDocument = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] = isRecord(value) && isRecord(existing) ? mergeInto(existing, value) : value;
  }
  return out;
}

/** Build the effective view without ever making a persisted layer own another layer's values. */
function buildRuntimeConfig(sources: RuntimeConfigSources): AppConfig {
  const { mcpServers: globalOverrides, ...globalSettings } = sources.global;
  const { mcpServers: localOverrides, ...localSettings } = sources.local;
  const main = mergeConfigLayers(sources.defaults, [
    globalSettings,
    localSettings,
    ...(sources.debug ? [{ logging: { level: "debug" } }] : []),
  ]);
  const withMcp = mergeAgentsMcpIntoConfig(
    main,
    sources.agentsServers,
    globalOverrides ?? {},
    localOverrides ?? {},
  );
  const runtime = structuredClone(withMcp) as unknown as ConfigDocument;
  for (const [path, value] of sources.resolvedSecrets) deepSet(runtime, path, value);
  return runtime as unknown as AppConfig;
}

/** Capture the already-resolved secret overlay so rebuilding sources never drops credentials. */
function snapshotResolvedSecrets(config: AppConfig): Map<string, string> {
  const values = new Map<string, string>();
  const paths = new Set([...SECRET_PATHS, ...runtimeSecretPaths(config)]);
  for (const path of paths) {
    const value = deepGet(config, path);
    if (nonEmptyString(value)) values.set(path, value);
  }
  return values;
}

/**
 * Durably replace a file that only the owning user can read. The replacement is a new file
 * created with that mode, so a wider mode on the old file does not carry over.
 */
function writePrivateFile(filePath: string, content: string): Effect.Effect<void, never> {
  return writeFileStringAtomic(filePath, content, { mode: CONFIG_FILE_MODE }).pipe(Effect.orDie);
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
 * The values of every secret Jazz holds outside the runtime config (see `heldSecretPaths`), from
 * the environment first and then `readKeyring`, named by their config path.
 */
export function resolveHeldSecrets(
  config: AppConfig,
  readKeyring: (path: string) => Effect.Effect<string | undefined, never>,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<KnownSecret[], never> {
  return Effect.gen(function* () {
    const outside = heldSecretPaths(config).filter(
      (path) => !nonEmptyString(deepGet(config, path)),
    );
    const found = yield* Effect.all(
      outside.map((path) => {
        const fromEnv = secretValueFromEnv(path, env);
        return nonEmptyString(fromEnv)
          ? Effect.succeed([path, fromEnv] as const)
          : readKeyring(path).pipe(Effect.map((value) => [path, value] as const));
      }),
      { concurrency: "unbounded" },
    );
    return found.flatMap(([name, value]) => (nonEmptyString(value) ? [{ name, value }] : []));
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Resolve secrets in precedence order — environment, then keyring, then the
 * config file — and move any plaintext left in the global config file into the
 * keyring when one is available.
 *
 * Returns the global file as it now stands on disk, which is what later writes edit. A secret
 * resolved from the environment or the keyring only ever lands in the runtime view.
 */
function resolveSecrets(
  fs: FileSystem.FileSystem,
  config: AppConfig,
  globalConfigPath: string,
  globalFile: GlobalConfigFileOnDisk | undefined,
  backend: KeyringBackend,
): Effect.Effect<{ config: AppConfig; document: ConfigDocument }, never> {
  return Effect.gen(function* () {
    yield* migrateKeyringProviderName(backend, keyringGet, keyringSet, keyringDelete);

    const resolved = structuredClone(config) as unknown as ConfigDocument;
    const fromEnv = new Set<string>();
    const candidates = new Set([...SECRET_PATHS, ...runtimeSecretPaths(config)]);

    for (const path of candidates) {
      const envValue = secretValueFromEnv(path);
      if (nonEmptyString(envValue)) {
        deepSet(resolved, path, envValue);
        fromEnv.add(path);
      }
    }

    if (backend !== "none") {
      const lookups = [...candidates].filter((path) => !fromEnv.has(path));
      const found = yield* Effect.all(
        lookups.map((path) =>
          keyringGet(backend, path).pipe(Effect.map((value) => [path, value] as const)),
        ),
        { concurrency: "unbounded" },
      );
      for (const [path, value] of found) {
        if (!nonEmptyString(value)) continue;
        deepSet(resolved, path, value);
      }
    }

    const document = globalFile?.document ?? {};
    const migrated = yield* migratePlaintextSecrets(backend, document, candidates);
    const droppedLegacy = dropLegacyGoogleBlock(document);

    if (
      globalFile !== undefined &&
      (migrated.length > 0 || droppedLegacy || globalFile.renamedProvider)
    ) {
      const cleaned = structuredClone(document);
      for (const path of migrated) {
        deepDelete(cleaned, path);
      }
      if (droppedLegacy) delete cleaned["google"];
      yield* writePrivateFile(globalConfigPath, JSON.stringify(cleaned, null, 2));
      if (droppedLegacy) noticeLegacyGoogleRemoved(globalConfigPath);
      return { config: resolved as unknown as AppConfig, document: cleaned };
    }

    yield* chmodQuietly(fs, globalConfigPath, CONFIG_FILE_MODE);
    return { config: resolved as unknown as AppConfig, document };
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

/** One config file as read from disk. */
interface ConfigFileOnDisk {
  readonly path: string;
  readonly document: ConfigDocument;
}

interface GlobalConfigFileOnDisk extends ConfigFileOnDisk {
  /** Whether the provider-name migration rewrote the document, so the file needs saving. */
  readonly renamedProvider: boolean;
}

interface ConfigFilesOnDisk {
  /** Where writes go, whether or not a file exists there yet. */
  readonly configPath: string;
  readonly global?: GlobalConfigFileOnDisk;
  /** The project file, with `storage` already removed: agents always live in the Jazz home. */
  readonly local?: ConfigFileOnDisk;
}

/**
 * Read a config file that may legitimately be absent. A file that exists but cannot be read, is
 * empty, or is not a JSON object fails the load: running on defaults instead would quietly drop
 * the user's limits and approvals.
 */
function readOptionalConfigFile(
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<GlobalConfigFileOnDisk | undefined, ConfigurationError> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) return undefined;

    const content = yield* fs.readFileString(filePath).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(
          new ConfigurationError({
            field: "file",
            message: `Cannot read config file at ${filePath}: ${String(cause)}`,
            suggestion: "Check the file permissions and try again.",
          }),
        ),
      ),
    );
    if (content === undefined) return undefined;
    if (!content.trim()) {
      return yield* Effect.fail(
        new ConfigurationError({
          field: "file",
          message: `Config file is empty: ${filePath}`,
          suggestion: "Delete the empty file or replace it with a JSON object.",
        }),
      );
    }

    const document = parseConfigDocument(content);
    if (document === undefined) {
      return yield* Effect.fail(
        new ConfigurationError({
          field: "format",
          message: `Config file is not a valid JSON object: ${filePath}`,
          suggestion: "Fix the JSON before starting Jazz.",
        }),
      );
    }

    const renamedProvider = migrateConfigProviderName(document);
    return { path: filePath, document, renamedProvider };
  });
}

/**
 * Read the project's `./.jazz/config.json`. Run from the directory holding the global file (a
 * home directory with the default `~/.jazz`), that path is the global file itself, which is then
 * not read a second time as a project override.
 */
function readLocalConfigFile(
  fs: FileSystem.FileSystem,
  globalConfigPath: string,
): Effect.Effect<ConfigFileOnDisk | undefined, ConfigurationError> {
  const localConfigPath = path.join(getLocalJazzDirectory(), "config.json");
  if (path.resolve(localConfigPath) === path.resolve(globalConfigPath)) {
    return Effect.succeed(undefined);
  }
  return readOptionalConfigFile(fs, localConfigPath).pipe(
    Effect.map((file) => {
      if (file === undefined) return undefined;
      const { storage: _storage, ...document } = file.document;
      return { path: file.path, document };
    }),
  );
}

function loadConfigFiles(
  fs: FileSystem.FileSystem,
  customConfigPath?: string,
): Effect.Effect<ConfigFilesOnDisk, ConfigurationError | ConfigurationNotFoundError> {
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
            suggestion:
              "Check the path passed to --config, or leave --config out to use the default config file.",
          }),
        );
      }

      const global = yield* readOptionalConfigFile(fs, expandedPath);
      const local = yield* readLocalConfigFile(fs, expandedPath);
      return {
        configPath: expandedPath,
        ...(global !== undefined ? { global } : {}),
        ...(local !== undefined ? { local } : {}),
      };
    }

    const globalConfigPath = getGlobalConfigFilePath();

    const global = yield* readOptionalConfigFile(fs, globalConfigPath);
    const local = yield* readLocalConfigFile(fs, globalConfigPath);
    return {
      configPath: globalConfigPath,
      ...(global !== undefined ? { global } : {}),
      ...(local !== undefined ? { local } : {}),
    };
  });
}

/** The user's own MCP definitions, shared with other MCP-aware tools. */
function userAgentsMcpPath(): string {
  return path.join(expandHome("~/.agents"), "mcp.json");
}

/** The current project's MCP definitions, which a cloned repository can supply. */
function projectAgentsMcpPath(): string {
  return path.resolve(process.cwd(), ".agents", "mcp.json");
}

const MCP_SECRET_FIELDS: readonly McpServerSecretField[] = ["env", "headers"];

type McpDefinitions = Record<string, Record<string, unknown>>;

/**
 * Read the server definitions in one `mcp.json`: `{ "mcpServers": {...} }` or a bare
 * `{ "name": {...} }` map. A missing, empty, or malformed file has no definitions.
 */
function readMcpDefinitions(
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<McpDefinitions, never> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      return {};
    }
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    if (!content.trim()) {
      return {};
    }
    const parsed = safeParseJson<unknown>(content);
    if (Option.isNone(parsed) || !isRecord(parsed.value)) {
      return {};
    }
    const record = parsed.value;
    const servers = isRecord(record["mcpServers"]) ? record["mcpServers"] : record;
    const definitions: McpDefinitions = {};
    for (const [name, definition] of Object.entries(servers)) {
      if (isRecord(definition)) {
        definitions[name] = definition;
      }
    }
    return definitions;
  });
}

/**
 * Fill a user server's empty env and header values from the keyring, where `jazz mcp add` put
 * them. A value the file spells out is used as written.
 */
function resolveMcpServerSecrets(
  backend: KeyringBackend,
  name: string,
  definition: Record<string, unknown>,
): Effect.Effect<Record<string, unknown>, never> {
  return Effect.gen(function* () {
    if (backend === "none") {
      return definition;
    }
    const resolved: Record<string, unknown> = { ...definition };
    for (const field of MCP_SECRET_FIELDS) {
      const values = definition[field];
      if (!isRecord(values)) {
        continue;
      }
      const lookups = yield* Effect.all(
        Object.entries(values).map(([key, value]) =>
          value === ""
            ? keyringGet(backend, mcpServerSecretPath(name, field, key)).pipe(
                Effect.map((secret) => [key, secret ?? ""] as const),
              )
            : Effect.succeed([key, value] as const),
        ),
        { concurrency: "unbounded" },
      );
      resolved[field] = Object.fromEntries(lookups);
    }
    return resolved;
  });
}

/** `transport` values an `mcp.json` may spell out. `sse` names the same HTTP client. */
const HTTP_TRANSPORT_NAMES: ReadonlySet<unknown> = new Set(["http", "sse"]);

/**
 * Settle one definition's transport from what it declares: a `url` makes it an HTTP server and a
 * `command` a stdio server, whether or not `transport` is spelled out. Drops `trusted` and
 * `definedIn`, which no `mcp.json` may set. Returns the reason when the definition names both,
 * neither, or a `transport` that contradicts them.
 */
export function normalizeMcpDefinition(
  definition: Record<string, unknown>,
): Record<string, unknown> | string {
  const { trusted: _trusted, definedIn: _definedIn, transport, ...rest } = definition;
  const hasUrl = typeof rest["url"] === "string" && rest["url"].trim() !== "";
  const hasCommand = typeof rest["command"] === "string" && rest["command"].trim() !== "";
  if (hasUrl && hasCommand) {
    return "it sets both `url` and `command`; keep `url` for a remote server or `command` for a local one.";
  }
  if (!hasUrl && !hasCommand) {
    return "it sets neither `url` (a remote server) nor `command` (a local one).";
  }
  if (hasUrl) {
    if (transport !== undefined && !HTTP_TRANSPORT_NAMES.has(transport)) {
      return `it has a \`url\` but \`transport\` is ${JSON.stringify(transport)}; use "http" or leave it out.`;
    }
    return { ...rest, transport: "http" };
  }
  if (transport !== undefined && transport !== "stdio") {
    return `it has a \`command\` but \`transport\` is ${JSON.stringify(transport)}; use "stdio" or leave it out.`;
  }
  return { ...rest, transport: "stdio" };
}

/**
 * Load MCP server definitions from the user's `~/.agents/mcp.json` and the project's
 * `./.agents/mcp.json`, tagging each with where it came from.
 *
 * A project definition never replaces a user definition of the same name: the name is what the
 * user's trust and OAuth tokens are filed under, so a repository that reuses it is warned about
 * and ignored. `trusted` inside any `mcp.json` is dropped, because trust is recorded only in the
 * global Jazz config. Empty env and header values of user servers resolve from the keyring.
 */
export function loadAgentsMcpServers(
  fs: FileSystem.FileSystem,
  backend: KeyringBackend,
): Effect.Effect<Record<string, MCPServerConfig>, never> {
  return Effect.gen(function* () {
    const userPath = userAgentsMcpPath();
    const projectPath = projectAgentsMcpPath();
    const user = yield* readMcpDefinitions(fs, userPath);
    const project =
      path.resolve(userPath) === projectPath ? {} : yield* readMcpDefinitions(fs, projectPath);

    const servers: Record<string, MCPServerConfig> = {};
    const add = (
      name: string,
      definition: Record<string, unknown>,
      definedIn: MCPServerDefinitionSource,
      filePath: string,
    ): void => {
      const normalized = normalizeMcpDefinition(definition);
      if (typeof normalized === "string") {
        process.stderr.write(`jazz: skipping MCP server "${name}" in ${filePath}: ${normalized}\n`);
        return;
      }
      servers[name] = { ...normalized, definedIn } as unknown as MCPServerConfig;
    };

    for (const [name, definition] of Object.entries(user)) {
      add(name, yield* resolveMcpServerSecrets(backend, name, definition), "user", userPath);
    }
    for (const [name, definition] of Object.entries(project)) {
      if (name in user) {
        process.stderr.write(
          `jazz: ignoring MCP server "${name}" in ${projectPath}: it has the same name as your ` +
            `server in ${userPath}, which Jazz keeps. Rename one of them to use both.\n`,
        );
        continue;
      }
      add(name, definition, "project", projectPath);
    }
    return servers;
  });
}

/**
 * Merge full MCP server definitions from .agents/mcp.json with the `enabled`/`trusted`
 * overrides from the Jazz config files, returning an updated AppConfig.
 */
function mergeAgentsMcpIntoConfig(
  config: AppConfig,
  agentsServers: Record<string, MCPServerConfig>,
  globalOverrides: Record<string, MCPServerOverride>,
  localOverrides: Record<string, MCPServerOverride>,
): AppConfig {
  if (Object.keys(agentsServers).length === 0) return config;
  return {
    ...config,
    mcpServers: mergeMcpServers(agentsServers, globalOverrides, localOverrides),
  };
}

/** Where `writeAgentsMcpServer` put each env var and header value, as `env.KEY`/`headers.Key`. */
export interface McpServerSecretPlacement {
  /** Values stored in the keyring; the file keeps their keys with empty values. */
  readonly keyring: readonly string[];
  /** Where the keyring values went, e.g. "the macOS keychain". */
  readonly keyringDescription: string;
  /** Values written into `~/.agents/mcp.json` because no keyring was usable or accepted them. */
  readonly file: readonly string[];
}

/** Delete the keyring entries of every env var and header a user definition names. */
function forgetMcpServerSecrets(
  backend: KeyringBackend,
  name: string,
  definition: unknown,
  retainedAccounts: ReadonlySet<string> = new Set(),
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (backend === "none" || !isRecord(definition)) {
      return;
    }
    for (const field of MCP_SECRET_FIELDS) {
      const values = definition[field];
      if (!isRecord(values)) {
        continue;
      }
      for (const key of Object.keys(values)) {
        const account = mcpServerSecretPath(name, field, key);
        if (!retainedAccounts.has(account)) yield* keyringDelete(backend, account);
      }
    }
  });
}

/** Write `~/.agents/mcp.json` in the wrapped format, readable only by the user. */
function writeUserMcpDefinitions(
  fs: FileSystem.FileSystem,
  servers: McpDefinitions,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const filePath = userAgentsMcpPath();
    yield* fs
      .makeDirectory(path.dirname(filePath), { recursive: true, mode: stateDirectoryMode() })
      .pipe(Effect.catchAll(() => Effect.void));
    yield* writeFileStringAtomic(
      filePath,
      `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      { mode: CONFIG_FILE_MODE },
    ).pipe(
      Effect.mapError(
        (cause) => new Error(`Could not write ${filePath}: ${String(cause)}`, { cause }),
      ),
    );
  });
}

/**
 * Serialize credential/file transactions without expiring a live owner's lock. Keyring calls
 * can take seconds per value, so elapsed time alone cannot safely identify an abandoned save.
 */
function withMcpDefinitionsLock<A>(operation: Effect.Effect<A, Error>): Effect.Effect<A, Error> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => acquireFileLock(`${userAgentsMcpPath()}.lock`, { maxHoldMs: Infinity }),
      catch: toError,
    }),
    () => operation,
    (release) => Effect.promise(release),
  );
}

/**
 * Add or replace one server in the user's `~/.agents/mcp.json`.
 *
 * Env var and header values go to the keyring, and the file keeps each key with an empty value
 * for Jazz to resolve on load. Without a usable keyring a value is written to the file, which is
 * kept at mode 0600 either way. Mutations are serialized and cannot be interrupted between
 * credential staging and file commit. Failed commits restore touched credentials; obsolete
 * credentials are deleted only after the replacement definition is committed.
 */
export function writeAgentsMcpServer(
  fs: FileSystem.FileSystem,
  name: string,
  config: Record<string, unknown>,
  keyringBackend?: KeyringBackend,
): Effect.Effect<McpServerSecretPlacement, Error> {
  const operation = Effect.gen(function* () {
    const existing = yield* readMcpDefinitions(fs, userAgentsMcpPath());
    const backend = keyringBackend ?? (yield* detectKeyringBackend());
    const previousValues = new Map<string, string | undefined>();
    const retainedAccounts = new Set<string>();

    const definition: Record<string, unknown> = { ...config };
    const inKeyring: string[] = [];
    const inFile: string[] = [];
    const commit = Effect.gen(function* () {
      for (const field of MCP_SECRET_FIELDS) {
        const values = config[field];
        if (!isRecord(values)) {
          continue;
        }
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(values)) {
          if (typeof value !== "string" || value === "") {
            kept[key] = value;
            continue;
          }
          const account = mcpServerSecretPath(name, field, key);
          if (backend !== "none") {
            const previous = yield* keyringGet(backend, account);
            const oldValues = existing[name]?.[field];
            if (previous === undefined && isRecord(oldValues) && oldValues[key] === "") {
              return yield* Effect.fail(
                new Error(
                  `Cannot safely replace ${account}: its existing keyring value could not be read. Unlock the keyring and retry, or remove the server before adding fresh credentials.`,
                ),
              );
            }
            previousValues.set(account, previous);
          }
          const stored = backend !== "none" && (yield* keyringSet(backend, account, value));
          if (stored) retainedAccounts.add(account);
          kept[key] = stored ? "" : value;
          (stored ? inKeyring : inFile).push(`${field}.${key}`);
        }
        definition[field] = kept;
      }

      yield* writeUserMcpDefinitions(fs, { ...existing, [name]: definition });
    });
    yield* commit.pipe(
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          const unrestored: string[] = [];
          for (const [account, previous] of previousValues) {
            if (previous === undefined) {
              yield* keyringDelete(backend, account);
            } else if (!(yield* keyringSet(backend, account, previous))) {
              unrestored.push(account);
            }
          }
          if (unrestored.length > 0) {
            return yield* Effect.fail(
              new Error(
                `MCP save failed and the keyring refused to restore ${unrestored.join(", ")}. Re-enter these credentials before using the server.`,
              ),
            );
          }
          return yield* Effect.failCause(cause);
        }),
      ),
    );
    yield* forgetMcpServerSecrets(backend, name, existing[name], retainedAccounts);
    return {
      keyring: inKeyring,
      keyringDescription: describeKeyringBackend(backend),
      file: inFile,
    };
  }).pipe(Effect.uninterruptible);
  return withMcpDefinitionsLock(operation);
}

/** Remove a server from `~/.agents/mcp.json`, and its env and header values from the keyring. */
export function removeAgentsMcpServer(
  fs: FileSystem.FileSystem,
  name: string,
  keyringBackend?: KeyringBackend,
): Effect.Effect<void, Error> {
  const operation = Effect.gen(function* () {
    const existing = yield* readMcpDefinitions(fs, userAgentsMcpPath());
    if (!(name in existing)) {
      return;
    }
    const backend = keyringBackend ?? (yield* detectKeyringBackend());
    const { [name]: _removed, ...rest } = existing;
    yield* writeUserMcpDefinitions(fs, rest);
    yield* forgetMcpServerSecrets(backend, name, existing[name]);
  }).pipe(Effect.uninterruptible);
  return withMcpDefinitionsLock(operation);
}

/**
 * Deep object property access using dot notation paths.
 *
 * The 'path' parameter uses dot notation to navigate nested objects:
 * - "name" -> obj.name
 * - "storage.type" -> obj.storage.type
 * - "logging.level" -> obj.logging.level
 * - 'llm.capabilityOverrides.nvidia."deepseek-ai/deepseek-v4.1-flash"' -> a quoted segment keeps its dots
 *
 * This allows flexible access to both simple and deeply nested properties
 * using the same interface, commonly used in configuration management.
 */
function deepGet(obj: object, path: string): unknown {
  const parts = splitConfigPath(path) ?? [];
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

/** A secret being cleared, matching what `storeSecret` treats as blank. */
function isBlankSecret(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Whether a dotted path can be written into the config object at all.
 *
 * False when the path goes through a list, by the schema or by the value in `config`.
 * `webhooks`, `peers` and `notify.targets` are lists of named entries, so `deepSet` on
 * `webhooks.mira.token` or `notify.targets.phone.botToken` would swap the list for an object
 * holding the secret in plaintext, whether or not the list exists yet.
 */
function structuralHomeFor(config: AppConfig, path: string): boolean {
  const segments = splitConfigPath(path);
  if (segments === undefined || segments.length === 0) {
    return false;
  }
  if (namedListEntryOf(path) !== undefined) {
    return false;
  }
  let current: unknown = config;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== "object") {
      return true;
    }
    current = (current as Record<string, unknown>)[segment];
    if (Array.isArray(current)) {
      return false;
    }
  }
  return true;
}

/**
 * Removes the value at a dot notation path, then discards any parent objects
 * the removal emptied — so dropping `llm.openai.api_key` does not leave an
 * orphaned `llm.openai: {}` behind in the written config.
 */
function deepDelete(obj: Record<string, unknown>, path: string): void {
  const parts = splitConfigPath(path) ?? [];
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

/**
 * Write a dotted path, creating intermediate objects as needed but refusing to descend into a list.
 *
 * `typeof [] === "object"`, so walking into an array attaches a named property to it — and
 * `JSON.stringify` drops named properties on arrays, so the value is written, reported as
 * saved, and then silently discarded on the next persist. Returns whether the write landed
 * so a caller can tell the difference between stored and quietly lost.
 */
function deepSet(obj: object, path: string, value: unknown): boolean {
  const parts = splitConfigPath(path);
  if (parts === undefined || parts.length === 0) {
    return false;
  }
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i] as string;
    if (i === parts.length - 1) {
      cur[key] = value;
    } else {
      const next = cur[key];
      if (Array.isArray(next)) return false;
      if (!next || typeof next !== "object") {
        cur[key] = {};
      }
      cur = cur[key] as Record<string, unknown>;
    }
  }
  return true;
}
