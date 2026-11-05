/**
 * `jazz config resolved`: provenance for every layer, overridden and ignored values, redaction,
 * the JSON shape, invalid-config errors, and proof that tracing leaves the merge unchanged.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { parseConfigFile } from "@jazz/core/utils/config-schema";
import { isRecord } from "@jazz/core/utils/is-record";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, FileSystem, Option } from "effect";
import {
  composeConfigLayers,
  defaultConfig,
  loadConfigFiles,
  mergeConfigLayers,
  withoutDisabledShellConfinement,
  withoutGlobalOnlySections,
  withoutWeakenedOpenRouterZdr,
} from "./config";
import {
  formatResolvedConfig,
  REDACTED,
  resolveConfig,
  type ResolvedConfigReport,
  type ResolvedSetting,
} from "./config-resolved";

const CANARY_FILE_KEY = "sk-canary-file-9f3a1c";
const CANARY_ENV_KEY = "sk-canary-env-71be04";
const CANARY_PROJECT_KEY = "sk-canary-project-55d2e8";
const CANARY_OTLP_HEADER = "Bearer canary-otlp-c0ffee";

interface Fixture {
  readonly global?: Record<string, unknown>;
  readonly project?: Record<string, unknown>;
  readonly debug?: boolean;
}

let originalJazzHome: string | undefined;
let originalConfigPath: string | undefined;
let originalCwd: string;
let jazzHome: string;
let projectDirectory: string;

beforeEach(() => {
  originalJazzHome = process.env["JAZZ_HOME"];
  originalConfigPath = process.env["JAZZ_CONFIG_PATH"];
  originalCwd = process.cwd();
  jazzHome = mkdtempSync(path.join(tmpdir(), "jazz-resolved-home-"));
  projectDirectory = mkdtempSync(path.join(tmpdir(), "jazz-resolved-project-"));
  process.env["JAZZ_HOME"] = jazzHome;
  delete process.env["JAZZ_CONFIG_PATH"];
  process.chdir(projectDirectory);
});

afterEach(() => {
  process.chdir(originalCwd);
  restoreEnv("JAZZ_HOME", originalJazzHome);
  restoreEnv("JAZZ_CONFIG_PATH", originalConfigPath);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function globalPath(): string {
  return path.join(jazzHome, "config.json");
}

function projectPath(): string {
  return path.join(process.cwd(), ".jazz", "config.json");
}

function writeFixture(fixture: Fixture): void {
  if (fixture.global !== undefined) {
    writeFileSync(globalPath(), JSON.stringify(fixture.global));
  }
  if (fixture.project !== undefined) {
    mkdirSync(path.dirname(projectPath()), { recursive: true });
    writeFileSync(projectPath(), JSON.stringify(fixture.project));
  }
}

async function resolve(
  fixture: Fixture,
  env: NodeJS.ProcessEnv = {},
): Promise<ResolvedConfigReport> {
  writeFixture(fixture);
  return Effect.runPromise(
    resolveConfig({ debug: fixture.debug === true, env }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function settingAt(report: ResolvedConfigReport, settingPath: string): ResolvedSetting {
  const found = [...report.settings, ...report.secrets].find((entry) => entry.path === settingPath);
  if (found === undefined) {
    throw new Error(`no setting at ${settingPath}`);
  }
  return found;
}

describe("provenance per layer", () => {
  it("attributes a key to the default, the global file, the project file and the flag", async () => {
    const report = await resolve({
      global: { llm: { ollama: { base_url: "http://global:11434" } } },
      project: { llm: { ollama: { keep_alive: "5m" } } },
      debug: true,
    });

    expect(settingAt(report, "logging.format").source).toEqual({ kind: "default" });
    expect(settingAt(report, "llm.ollama.base_url").source).toEqual({
      kind: "global",
      path: globalPath(),
    });
    expect(settingAt(report, "llm.ollama.keep_alive").source).toEqual({
      kind: "project",
      path: projectPath(),
    });
    expect(settingAt(report, "logging.level").source).toEqual({ kind: "flag", flag: "--debug" });
  });

  it("keeps a global sibling when the project sets another key of the same section", async () => {
    const report = await resolve({
      global: { llm: { ollama: { base_url: "http://global:11434" } } },
      project: { llm: { ollama: { keep_alive: "5m" } } },
    });
    expect(settingAt(report, "llm.ollama.base_url").value).toBe("http://global:11434");
    expect(settingAt(report, "llm.ollama.keep_alive").value).toBe("5m");
  });

  it("reports the layers lowest to highest with whether each file exists", async () => {
    const report = await resolve({ global: { logging: { level: "warn" } } });
    expect(report.layers.map((layer) => [layer.name, layer.found])).toEqual([
      ["default", undefined],
      ["global", true],
      ["project", false],
      ["flag", false],
    ]);
  });

  it("works with no config files at all", async () => {
    const report = await resolve({});
    expect(settingAt(report, "logging.level").source).toEqual({ kind: "default" });
    expect(report.ignored).toEqual([]);
  });
});

describe("overridden and ignored values", () => {
  it("lists every lower value a key replaced, lowest precedence first", async () => {
    const report = await resolve({
      global: { logging: { level: "warn" } },
      project: { logging: { level: "error" } },
      debug: true,
    });
    const level = settingAt(report, "logging.level");
    expect(level.value).toBe("debug");
    expect(level.overridden.map((entry) => [entry.value, entry.source.kind])).toEqual([
      ["info", "default"],
      ["warn", "global"],
      ["error", "project"],
    ]);
  });

  it("shows a project shell.confinement off as ignored and keeps the global value", async () => {
    const report = await resolve({
      global: { shell: { confinement: "on" } },
      project: { shell: { confinement: "off" } },
    });
    expect(settingAt(report, "shell.confinement")).toMatchObject({
      value: "on",
      source: { kind: "global" },
    });
    expect(report.ignored).toEqual([
      {
        path: "shell.confinement",
        value: "off",
        source: { kind: "project", path: projectPath() },
        reason: "a project config can turn write confinement on but not off",
      },
    ]);
  });

  it("keeps a project shell.confinement on", async () => {
    const report = await resolve({ project: { shell: { confinement: "on" } } });
    expect(settingAt(report, "shell.confinement").source.kind).toBe("project");
    expect(report.ignored).toEqual([]);
  });

  it("shows every operator-only project setting as ignored with a reason", async () => {
    const report = await resolve({
      project: {
        storage: { type: "file", path: "/elsewhere" },
        network: { allowPrivateHosts: ["10.0.0.0/8"] },
        llm: { openrouter: { zdr: false } },
      },
    });
    expect(report.ignored.map((drop) => drop.path)).toEqual([
      "llm.openrouter.zdr",
      "network",
      "storage",
    ]);
    expect(report.ignored.every((drop) => drop.reason.length > 0)).toBe(true);
    expect(report.settings.find((entry) => entry.path === "storage.path")?.source.kind).toBe(
      "default",
    );
  });

  it("shows a project mcpServers trusted as ignored and applies its enabled", async () => {
    const report = await resolve({
      global: { mcpServers: { files: { trusted: true } } },
      project: { mcpServers: { files: { enabled: false, trusted: true } } },
    });
    expect(settingAt(report, "mcpServers.files.enabled").source.kind).toBe("project");
    expect(settingAt(report, "mcpServers.files.trusted").source.kind).toBe("global");
    expect(report.ignored.map((drop) => drop.path)).toEqual(["mcpServers.files.trusted"]);
  });
});

describe("environment overrides and redaction", () => {
  it("attributes a provider key to its environment variable and lists the file value under it", async () => {
    const report = await resolve(
      { global: { llm: { openai: { api_key: CANARY_FILE_KEY } } } },
      { OPENAI_API_KEY: CANARY_ENV_KEY },
    );
    const secret = settingAt(report, "llm.openai.api_key");
    expect(secret.value).toBe(REDACTED);
    expect(secret.source).toEqual({ kind: "env", variable: "OPENAI_API_KEY" });
    expect(secret.overridden).toEqual([
      { value: REDACTED, source: { kind: "global", path: globalPath() } },
    ]);
  });

  it("names a secret held only in a config file and reports where the rest live", async () => {
    const report = await resolve({ global: { llm: { openai: { api_key: CANARY_FILE_KEY } } } });
    expect(settingAt(report, "llm.openai.api_key").source.kind).toBe("global");
    expect(report.secretStore.inspected).toBe(false);
    expect(report.secretStore.description.length).toBeGreaterThan(0);
  });

  it("never prints a secret value in text or JSON, from any layer or the environment", async () => {
    const report = await resolve(
      {
        global: {
          llm: { openai: { api_key: CANARY_FILE_KEY } },
          telemetry: { otlp: { headers: { authorization: CANARY_OTLP_HEADER } } },
        },
        project: {
          companions: {
            ocr: {
              provider: "openai",
              model: "gpt-x",
              api_key: CANARY_PROJECT_KEY,
            },
          },
        },
      },
      { OPENAI_API_KEY: CANARY_ENV_KEY },
    );
    const text = formatResolvedConfig(report);
    const json = JSON.stringify(report);
    for (const canary of [
      CANARY_FILE_KEY,
      CANARY_ENV_KEY,
      CANARY_PROJECT_KEY,
      CANARY_OTLP_HEADER,
    ]) {
      expect(text).not.toContain(canary);
      expect(json).not.toContain(canary);
    }
    expect(text).toContain(REDACTED);
  });
});

describe("output", () => {
  it("sorts settings, secrets and ignored values and is identical across runs", async () => {
    const fixture: Fixture = {
      global: { shell: { confinement: "on" }, logging: { level: "warn" } },
      project: { llm: { openrouter: { zdr: false } }, shell: { confinement: "off" } },
    };
    const first = await resolve(fixture, { OPENAI_API_KEY: CANARY_ENV_KEY });
    const second = await resolve(fixture, { OPENAI_API_KEY: CANARY_ENV_KEY });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(formatResolvedConfig(first)).toBe(formatResolvedConfig(second));
    for (const list of [first.settings, first.secrets, first.ignored]) {
      const paths = list.map((entry) => entry.path);
      expect(paths).toEqual([...paths].sort());
    }
  });

  it("has the documented JSON shape", async () => {
    const report = await resolve({ global: { logging: { level: "warn" } } });
    expect(Object.keys(JSON.parse(JSON.stringify(report))).sort()).toEqual([
      "ignored",
      "layers",
      "locations",
      "secretStore",
      "secrets",
      "settings",
    ]);
    expect(settingAt(report, "logging.level")).toEqual({
      path: "logging.level",
      value: "warn",
      source: { kind: "global", path: globalPath() },
      overridden: [{ value: "info", source: { kind: "default" } }],
    });
  });

  it("renders the provenance in text", async () => {
    const report = await resolve({ global: { logging: { level: "warn" } } });
    const text = formatResolvedConfig(report);
    expect(text).toContain(`logging.level = "warn"`);
    expect(text).toContain(`from global file ${globalPath()}`);
    expect(text).toContain(`replaced "info" from default`);
  });
});

describe("invalid configuration", () => {
  it("fails naming the project file and the unknown key", async () => {
    writeFixture({ project: { logging: { levle: "warn" } } });
    const exit = await Effect.runPromiseExit(
      resolveConfig({ env: {} }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
    const message = Option.isSome(failure) ? String((failure.value as Error).message) : "";
    expect(message).toContain(projectPath());
    expect(message).toContain("levle");
  });

  it("fails on a global file that is not JSON, naming the file", async () => {
    writeFileSync(globalPath(), "{not json");
    const exit = await Effect.runPromiseExit(
      resolveConfig({ env: {} }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
    expect(Option.isSome(failure) ? String((failure.value as Error).message) : "").toContain(
      globalPath(),
    );
  });
});

describe("tracing leaves the merge unchanged", () => {
  const fixtures: readonly Fixture[] = [
    {},
    { global: { logging: { level: "warn" } } },
    { project: { logging: { level: "error" }, shell: { confinement: "on" } } },
    {
      global: { shell: { confinement: "on" }, llm: { ollama: { base_url: "http://g:1" } } },
      project: {
        shell: { confinement: "off" },
        llm: { ollama: { keep_alive: "1m" }, openrouter: { zdr: false } },
        network: { allowPrivateHosts: ["10.0.0.0/8"] },
      },
      debug: true,
    },
    {
      global: { peers: [{ name: "a", url: "http://a" }] },
      project: { peers: [{ name: "b", url: "http://b" }], storage: { type: "file", path: "/x" } },
    },
  ];

  function loadFiles(): Promise<Awaited<ReturnType<typeof readFiles>>> {
    return readFiles();
  }

  function readFiles() {
    return Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* loadConfigFiles(fileSystem, undefined);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
  }

  /** The merge as it was before tracing existed: validate, strip the project, merge. */
  async function previousMerge(fixture: Fixture): Promise<unknown> {
    const files = await loadFiles();
    const silent = (): void => undefined;
    const global = parseConfigFile(files.global?.document ?? {}).config;
    const local =
      files.local === undefined
        ? {}
        : withoutDisabledShellConfinement(
            files.local.path,
            withoutWeakenedOpenRouterZdr(
              files.local.path,
              withoutGlobalOnlySections(
                files.local.path,
                parseConfigFile(files.local.document).config,
                silent,
              ),
              silent,
            ),
            silent,
          );
    const { mcpServers: _globalMcp, ...globalSettings } = global;
    const { mcpServers: _localMcp, ...localSettings } = local as Record<string, unknown>;
    return mergeConfigLayers(defaultConfig(), [
      globalSettings,
      localSettings,
      ...(fixture.debug === true ? [{ logging: { level: "debug" } }] : []),
    ]);
  }

  function leaves(value: unknown, prefix: string, into: Map<string, unknown>): void {
    if (isRecord(value)) {
      for (const [key, nested] of Object.entries(value)) {
        leaves(nested, prefix === "" ? key : `${prefix}.${key}`, into);
      }
      return;
    }
    into.set(prefix, value);
  }

  for (const [index, fixture] of fixtures.entries()) {
    it(`gives the same merged configuration for fixture ${index}`, async () => {
      writeFixture(fixture);
      const expected = await previousMerge(fixture);
      const files = await loadFiles();
      const composed = await Effect.runPromise(
        composeConfigLayers(files, fixture.debug, () => undefined),
      );
      expect(composed.mainConfig).toEqual(expected as typeof composed.mainConfig);

      const report = await Effect.runPromise(
        resolveConfig({ debug: fixture.debug === true, env: {} }).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      );
      const merged = new Map<string, unknown>();
      leaves(composed.mainConfig, "", merged);
      const traced = new Map<string, unknown>();
      for (const entry of [...report.settings, ...report.secrets]) {
        if (!entry.path.startsWith("mcpServers")) {
          traced.set(entry.path, entry.value);
        }
      }
      expect(traced).toEqual(merged);
    });
  }
});
