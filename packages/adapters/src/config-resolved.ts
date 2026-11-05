/**
 * `jazz config resolved`: the effective configuration with the layer that set each key.
 *
 * Reads the config files the runtime reads and merges them with the runtime's own merge, then
 * traces each key back to its layer. It reads no keyring, starts no daemon and calls no provider,
 * so it works on a machine with nothing configured and with no network. Every secret value is
 * replaced by `<redacted>` before the report is built, so no formatter downstream can print one.
 */

import {
  heldSecretPaths,
  isSecretPath,
  llmProviderEnvVars,
  envVarForSecretPath,
} from "@jazz/core/secrets/registry";
import { isSecretName } from "@jazz/core/secrets/secret-names";
import type { ConfigurationError, ConfigurationNotFoundError } from "@jazz/core/types/errors";
import { isRecord } from "@jazz/core/utils/is-record";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect, FileSystem } from "effect";
import {
  composeConfigLayers,
  defaultConfig,
  documentOf,
  loadConfigFiles,
  projectOverrideDrops,
  requireValidEffectiveConfig,
} from "./config";
import {
  compareText,
  type ConfigSource,
  type DroppedSetting,
  type OverriddenValue,
  traceLayers,
  type TracedSetting,
} from "./config-provenance";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  type KeyringBackend,
} from "./secrets/keyring";

/** What stands in for every secret value in the report. */
export const REDACTED = "<redacted>";

export interface ResolveConfigOptions {
  /** Whether `--debug` was passed. */
  readonly debug?: boolean;
  /** Whether `--config <path>` named the global file. */
  readonly configPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ResolvedLayer {
  readonly name: "default" | "global" | "project" | "flag";
  readonly path?: string;
  readonly flag?: string;
  /** For a file layer: whether the file exists. */
  readonly found?: boolean;
}

export interface ResolvedSetting {
  readonly path: string;
  readonly value: unknown;
  readonly source: ConfigSource;
  readonly overridden: readonly OverriddenValue[];
}

export interface ResolvedConfigReport {
  readonly layers: readonly ResolvedLayer[];
  readonly locations: {
    readonly jazzHome: { readonly path: string; readonly selectedBy: string };
    readonly globalConfig: { readonly path: string; readonly selectedBy: string };
  };
  /** Where secrets live when neither the environment nor a config file holds them. */
  readonly secretStore: {
    readonly backend: KeyringBackend;
    readonly description: string;
    readonly inspected: false;
  };
  readonly settings: readonly ResolvedSetting[];
  /** Secrets set through the environment or a config file; the value is always `<redacted>`. */
  readonly secrets: readonly ResolvedSetting[];
  /** Values a layer set that the loader did not apply. */
  readonly ignored: readonly DroppedSetting[];
}

function lastSegment(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? path : path.slice(index + 1);
}

/** Whether the value at `path` is a credential: a registered secret path or a secret-named key. */
function holdsSecret(path: string): boolean {
  return isSecretPath(path) || isSecretName(lastSegment(path));
}

/** `value` with every secret beneath `path` replaced by `<redacted>`. */
function redactAt(value: unknown, path: string): unknown {
  if (holdsSecret(path) && value !== "" && value !== null && value !== undefined) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactAt(item, `${path}.${index}`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactAt(nested, `${path}.${key}`)]),
    );
  }
  return value;
}

function redactSetting(setting: TracedSetting): ResolvedSetting {
  return {
    path: setting.path,
    value: redactAt(setting.value, setting.path),
    source: setting.source,
    overridden: setting.overridden.map((entry) => ({
      value: redactAt(entry.value, setting.path),
      source: entry.source,
    })),
  };
}

/** The first environment variable that supplies the secret at `path`, or undefined. */
function secretEnvVariable(path: string, env: NodeJS.ProcessEnv): string | undefined {
  const llm = /^llm\.([^.]+)\.api_key$/.exec(path);
  const candidates =
    llm?.[1] !== undefined ? llmProviderEnvVars(llm[1]) : [envVarForSecretPath(path)];
  return candidates.find(
    (name): name is string => name !== undefined && (env[name] ?? "").trim() !== "",
  );
}

function selectedGlobalBy(options: ResolveConfigOptions, env: NodeJS.ProcessEnv): string {
  if (options.configPath !== undefined && options.configPath !== "") {
    return "--config";
  }
  return (env["JAZZ_CONFIG_PATH"] ?? "").trim() !== "" ? "JAZZ_CONFIG_PATH" : "default";
}

/**
 * The effective configuration with provenance. Fails with the same error `jazz config validate`
 * gives when a file or the merged configuration is invalid, naming the file and the key.
 */
export function resolveConfig(
  options: ResolveConfigOptions = {},
): Effect.Effect<
  ResolvedConfigReport,
  ConfigurationError | ConfigurationNotFoundError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const env = options.env ?? process.env;
    const fs = yield* FileSystem.FileSystem;
    const files = yield* loadConfigFiles(fs, options.configPath);
    const composed = yield* composeConfigLayers(files, options.debug, () => undefined);
    yield* requireValidEffectiveConfig(composed.mainConfig);

    const globalSource: ConfigSource = { kind: "global", path: files.configPath };
    const localPath = files.local?.path;
    const projectSource: ConfigSource | undefined =
      localPath === undefined ? undefined : { kind: "project", path: localPath };
    const flagSource: ConfigSource = { kind: "flag", flag: "--debug" };

    const projectDocument = Object.fromEntries(
      Object.entries(composed.checkedLocal).filter(([key]) => key !== "mcpServers"),
    );
    const projectMcpServers = Object.fromEntries(
      Object.entries(composed.localOverrides ?? {}).map(([name, override]) => {
        const { trusted: _trusted, ...applied } = override;
        return [name, applied];
      }),
    );

    const traced = traceLayers([
      {
        source: { kind: "default" },
        document: documentOf(defaultConfig()),
      },
      ...(files.global === undefined
        ? []
        : [{ source: globalSource, document: composed.checkedGlobal }]),
      ...(projectSource === undefined
        ? []
        : [
            {
              source: projectSource,
              document: { ...projectDocument, mcpServers: projectMcpServers },
            },
          ]),
      ...(options.debug === true
        ? [{ source: flagSource, document: { logging: { level: "debug" } } }]
        : []),
    ]);

    const secrets = new Map<string, ResolvedSetting>();
    const settings: ResolvedSetting[] = [];
    for (const setting of traced) {
      const redacted = redactSetting(setting);
      if (holdsSecret(setting.path)) {
        secrets.set(setting.path, redacted);
      } else {
        settings.push(redacted);
      }
    }

    for (const path of heldSecretPaths(composed.mainConfig)) {
      const variable = secretEnvVariable(path, env);
      if (variable === undefined) {
        continue;
      }
      const existing = secrets.get(path);
      secrets.set(path, {
        path,
        value: REDACTED,
        source: { kind: "env", variable },
        overridden:
          existing === undefined
            ? []
            : [...existing.overridden, { value: existing.value, source: existing.source }],
      });
    }

    const ignored: DroppedSetting[] =
      localPath === undefined
        ? []
        : projectOverrideDrops(localPath, composed.validatedLocal, files.local?.ignoredStorage).map(
            (drop) => ({ ...drop, value: redactAt(drop.value, drop.path) }),
          );

    const backend = yield* detectKeyringBackend();
    const byPath = (first: { path: string }, second: { path: string }): number =>
      compareText(first.path, second.path);

    return {
      layers: [
        { name: "default" },
        { name: "global", path: files.configPath, found: files.global !== undefined },
        {
          name: "project",
          path: localPath ?? "./.jazz/config.json",
          found: files.local !== undefined,
        },
        { name: "flag", flag: "--debug", found: options.debug === true },
      ],
      locations: {
        jazzHome: {
          path: getJazzHomeDirectory(),
          selectedBy: (env["JAZZ_HOME"] ?? "").trim() !== "" ? "JAZZ_HOME" : "default",
        },
        globalConfig: { path: files.configPath, selectedBy: selectedGlobalBy(options, env) },
      },
      secretStore: { backend, description: describeKeyringBackend(backend), inspected: false },
      settings: settings.sort(byPath),
      secrets: [...secrets.values()].sort(byPath),
      ignored: ignored.sort(byPath),
    };
  });
}

/** The label a source carries in text output. */
export function describeSource(source: ConfigSource): string {
  switch (source.kind) {
    case "default":
      return "default";
    case "global":
      return `global file ${source.path}`;
    case "project":
      return `project file ${source.path}`;
    case "flag":
      return `flag ${source.flag}`;
    case "env":
      return `environment ${source.variable}`;
  }
}

function formatValue(value: unknown): string {
  return value === REDACTED ? REDACTED : JSON.stringify(value);
}

function formatSettings(settings: readonly ResolvedSetting[]): string[] {
  return settings.flatMap((setting) => [
    `  ${setting.path} = ${formatValue(setting.value)}`,
    `      from ${describeSource(setting.source)}`,
    ...setting.overridden.map(
      (entry) => `      replaced ${formatValue(entry.value)} from ${describeSource(entry.source)}`,
    ),
  ]);
}

/** The text a terminal shows: layers, settings, secrets and ignored values, each sorted. */
export function formatResolvedConfig(report: ResolvedConfigReport): string {
  const lines: string[] = ["Layers, lowest to highest precedence"];
  for (const layer of report.layers) {
    const where = layer.path ?? layer.flag ?? "";
    const state = layer.found === undefined ? "" : layer.found ? "  (present)" : "  (not found)";
    lines.push(`  ${layer.name}  ${where}${state}`.trimEnd());
  }
  lines.push(
    "",
    `Global config chosen by ${report.locations.globalConfig.selectedBy}`,
    `Jazz home ${report.locations.jazzHome.path} (chosen by ${report.locations.jazzHome.selectedBy})`,
    "",
    "Settings",
    ...(report.settings.length === 0 ? ["  none"] : formatSettings(report.settings)),
    "",
    "Secrets (values are never shown)",
    ...(report.secrets.length === 0
      ? ["  none set in the environment or a config file"]
      : formatSettings(report.secrets)),
    `  Other secrets live in ${report.secretStore.description}; this command does not read it.`,
  );
  if (report.ignored.length > 0) {
    lines.push("", "Ignored");
    for (const drop of report.ignored) {
      lines.push(
        `  ${drop.path} = ${formatValue(drop.value)}`,
        `      from ${describeSource(drop.source)}`,
        `      not applied: ${drop.reason}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
