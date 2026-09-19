import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { type AppConfig } from "@jazz/core/types/index";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { AgentConfigServiceImpl, createConfigLayer, validateConfigFiles } from "./config";

// Mock FileSystem
const mockFS = {
  writeFileString: mock(() => Effect.void),
  makeDirectory: mock(() => Effect.void),
  access: mock(() => Effect.void),
  copy: mock(() => Effect.void),
  copyFile: mock(() => Effect.void),
  chmod: mock(() => Effect.void),
  chown: mock(() => Effect.void),
  exists: mock(() => Effect.succeed(true)),
  link: mock(() => Effect.void),
  lstat: mock(() => Effect.succeed({})),
  mkdir: mock(() => Effect.void),
  makeTempDirectory: mock(() => Effect.succeed("")),
  makeTempDirectoryScoped: mock(() => Effect.succeed("")),
  makeTempFile: mock(() => Effect.succeed("")),
  makeTempFileScoped: mock(() => Effect.succeed("")),
  open: mock(() => Effect.succeed({})),
  readDirectory: mock(() => Effect.succeed([])),
  readFile: mock(() => Effect.succeed(new Uint8Array())),
  readFileString: mock(() => Effect.succeed("")),
  readSymbolicLink: mock(() => Effect.succeed("")),
  realpath: mock(() => Effect.succeed("")),
  remove: mock(() => Effect.void),
  rename: mock(() => Effect.void),
  removeFile: mock(() => Effect.void),
  stat: mock(() => Effect.succeed({})),
  symlink: mock(() => Effect.void),
  truncate: mock(() => Effect.void),
  utimes: mock(() => Effect.void),
  writeFile: mock(() => Effect.void),
} as unknown as FileSystem.FileSystem;

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

describe("AgentConfigService", () => {
  const initialConfig: AppConfig = {
    storage: { type: "file", path: "/tmp" },
    logging: { level: "info", format: "plain" },
    llm: {},
    web_search: { provider: "parallel" },
  };

  it("should get nested properties using dot notation", async () => {
    const service = new AgentConfigServiceImpl(initialConfig, {}, undefined, mockFS);

    const level = await Effect.runPromise(service.get<string>("logging.level"));
    expect(level).toBe("info");

    const missing = await Effect.runPromise(service.get("non.existent"));
    expect(missing).toBeUndefined();
  });

  it("treats a blank API key as missing", async () => {
    const service = new AgentConfigServiceImpl(
      {
        ...initialConfig,
        llm: { ollama: { api_key: "   " } },
      },
      {},
      undefined,
      mockFS,
    );

    expect(await Effect.runPromise(service.has("llm.ollama.api_key"))).toBe(false);
    expect(await Effect.runPromise(service.has("logging.level"))).toBe(true);
  });

  it("should set properties and persist to file", async () => {
    const configPath = "/tmp/config.json";
    const service = new AgentConfigServiceImpl(initialConfig, {}, configPath, mockFS);

    await Effect.runPromise(service.set("llm.openai.api_key", "sk-test"));

    const key = await Effect.runPromise(service.get("llm.openai.api_key"));
    expect(key).toBe("sk-test");
    const writeCalls = (mockFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    expect(writeCalls[writeCalls.length - 1]?.[0]).toMatch(/^\/tmp\/\.jazz-config-.*\.tmp$/);
    expect(writeCalls[writeCalls.length - 1]?.[1]).toContain("sk-test");
    expect(writeCalls[writeCalls.length - 1]?.[2]).toEqual({ mode: 0o600 });
    expect(mockFS.rename).toHaveBeenCalledWith(expect.any(String), configPath);
  });

  it("writes the config file owner-only and repairs an existing mode", async () => {
    const configPath = "/tmp/config-mode.json";
    const service = new AgentConfigServiceImpl(initialConfig, {}, configPath, mockFS);

    await Effect.runPromise(service.set("logging.level", "debug"));

    const writeCalls = (mockFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    expect(writeCalls[writeCalls.length - 1]?.[2]).toEqual({ mode: 0o600 });
    expect(mockFS.chmod).toHaveBeenCalledWith(configPath, 0o600);
  });

  it("creates the config directory owner-only", async () => {
    const service = new AgentConfigServiceImpl(initialConfig, {}, undefined, mockFS);

    await Effect.runPromise(service.set("logging.level", "debug"));

    const dirCalls = (mockFS.makeDirectory as ReturnType<typeof mock>).mock.calls;
    expect(dirCalls).toContainEqual([getJazzHomeDirectory(), { recursive: true, mode: 0o700 }]);
  });

  it("should return default value for missing keys with getOrElse", async () => {
    const service = new AgentConfigServiceImpl(initialConfig, {}, undefined, mockFS);
    const value = await Effect.runPromise(service.getOrElse("missing.key", "default"));
    expect(value).toBe("default");
  });

  it("should persist only mcpOverrides (enabled) to jazz config, not full definitions", async () => {
    const configPath = "/tmp/jazz-mcp-overrides-test.json";
    const configWithMcp: AppConfig = {
      ...initialConfig,
      mcpServers: {
        testServer: {
          name: "testServer",
          command: "npx",
          args: ["-y", "some-mcp"],
          enabled: true,
        },
      },
    };
    const fileDocument = { mcpServers: { testServer: { enabled: true } } };
    const service = new AgentConfigServiceImpl(configWithMcp, fileDocument, configPath, mockFS);

    await Effect.runPromise(service.set("mcpServers.testServer.enabled", false));

    expect(mockFS.writeFileString).toHaveBeenCalled();
    const calls = (mockFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    const written = calls[calls.length - 1]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.testServer).toEqual({ enabled: false });
    expect(parsed.mcpServers.testServer.command).toBeUndefined();
  });

  it("should persist the trusted override alongside enabled", async () => {
    // Trust decides whether a server's own tool annotations may skip approval
    // prompts, so dropping it here would silently make every `mcp trust` a
    // no-op.
    const configPath = "/tmp/jazz-mcp-trust-test.json";
    const configWithMcp: AppConfig = {
      ...initialConfig,
      mcpServers: {
        testServer: {
          name: "testServer",
          command: "npx",
          args: ["-y", "some-mcp"],
          enabled: true,
        },
      },
    };
    const service = new AgentConfigServiceImpl(
      configWithMcp,
      { mcpServers: { testServer: { enabled: true } } },
      configPath,
      mockFS,
    );

    await Effect.runPromise(service.set("mcpServers.testServer.trusted", true));

    const calls = (mockFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    const parsed = JSON.parse(calls[calls.length - 1]?.[1] as string);
    expect(parsed.mcpServers.testServer).toEqual({ enabled: true, trusted: true });
  });

  it("should persist a trusted override for a server whose enabled state was never set", async () => {
    const configPath = "/tmp/jazz-mcp-trust-only-test.json";
    const configWithMcp: AppConfig = {
      ...initialConfig,
      mcpServers: {
        testServer: { name: "testServer", command: "npx" },
      },
    };
    const service = new AgentConfigServiceImpl(configWithMcp, {}, configPath, mockFS);

    await Effect.runPromise(service.set("mcpServers.testServer.trusted", true));

    const calls = (mockFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    const parsed = JSON.parse(calls[calls.length - 1]?.[1] as string);
    expect(parsed.mcpServers.testServer).toEqual({ trusted: true });
  });
});

describe("createConfigLayer", () => {
  function createTestFileSystem(fileContents: Map<string, string>): FileSystem.FileSystem {
    const writeFileString = mock((filePath: string, content: string) =>
      Effect.sync(() => fileContents.set(filePath, content)),
    );
    return {
      exists: (filePath: string) => Effect.succeed(fileContents.has(filePath)),
      readFileString: (filePath: string) => Effect.succeed(fileContents.get(filePath) ?? ""),
      writeFileString,
      makeDirectory: mock(() => Effect.void),
      rename: mock((from: string, to: string) =>
        Effect.sync(() => {
          const content = fileContents.get(from);
          if (content !== undefined) fileContents.set(to, content);
          fileContents.delete(from);
        }),
      ),
      remove: mock((filePath: string) => Effect.sync(() => fileContents.delete(filePath))),
      chmod: mock(() => Effect.void),
    } as unknown as FileSystem.FileSystem;
  }

  it("removes the legacy google client block from the config file", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map<string, string>([
      [
        globalPath,
        JSON.stringify({
          logging: { level: "info" },
          google: { clientId: "dead-id", clientSecret: "dead-secret" },
        }),
      ],
    ]);
    const testFS = createTestFileSystem(fileContents);

    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
    );
    await Effect.runPromise(Effect.provide(AgentConfigServiceTag, layer));

    const calls = (testFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const written = calls[calls.length - 1]?.[1] as string;
    expect(written).not.toContain("dead-secret");
    expect(JSON.parse(written).google).toBeUndefined();
    expect(JSON.parse(written).logging).toEqual({ level: "info" });
  });

  it("warns about a repurposed unknown google block without blocking startup", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map<string, string>([
      [globalPath, JSON.stringify({ google: { somethingElse: "keep-me" } })],
    ]);
    const testFS = createTestFileSystem(fileContents);

    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
    );
    const { stderr } = await captureStderr(() =>
      Effect.runPromise(Effect.provide(AgentConfigServiceTag, layer)),
    );

    expect(stderr).toContain("google: not a setting");
    const calls = (testFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    expect(calls.length).toBe(0);
  });

  it("resolves secrets from the environment over the config file", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map<string, string>([
      [globalPath, JSON.stringify({ llm: { openai: { api_key: "sk-from-file" } } })],
    ]);

    process.env["OPENAI_API_KEY"] = "sk-from-env";
    process.env["BRAVE_API_KEY"] = "brave-from-env";
    try {
      const layer = createConfigLayer().pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
      );
      const program = Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        return {
          openai: yield* config.get<string>("llm.openai.api_key"),
          brave: yield* config.get<string>("web_search.brave.api_key"),
        };
      }).pipe(Effect.provide(layer));

      const result = await Effect.runPromise(program);
      expect(result.openai).toBe("sk-from-env");
      expect(result.brave).toBe("brave-from-env");
    } finally {
      delete process.env["OPENAI_API_KEY"];
      delete process.env["BRAVE_API_KEY"];
    }
  });

  it("never writes an env-supplied secret into the config file", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map<string, string>([[globalPath, JSON.stringify({})]]);
    const testFS = createTestFileSystem(fileContents);

    process.env["OPENAI_API_KEY"] = "sk-from-env";
    try {
      const layer = createConfigLayer().pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
      );
      const program = Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        yield* config.set("logging.level", "debug");
      }).pipe(Effect.provide(layer));

      await Effect.runPromise(program);

      const calls = (testFS.writeFileString as ReturnType<typeof mock>).mock.calls;
      const written = calls[calls.length - 1]?.[1] as string;
      expect(written).not.toContain("sk-from-env");
      expect(JSON.parse(written).llm?.openai).toBeUndefined();
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  it("keeps a file-stored secret on disk even when an env var shadows it", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map<string, string>([
      [globalPath, JSON.stringify({ llm: { openai: { api_key: "sk-from-file" } } })],
    ]);
    const testFS = createTestFileSystem(fileContents);

    process.env["OPENAI_API_KEY"] = "sk-from-env";
    try {
      const layer = createConfigLayer().pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
      );
      const program = Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        yield* config.set("logging.level", "debug");
      }).pipe(Effect.provide(layer));

      await Effect.runPromise(program);

      const calls = (testFS.writeFileString as ReturnType<typeof mock>).mock.calls;
      const written = JSON.parse(calls[calls.length - 1]?.[1] as string);
      expect(written.llm.openai.api_key).toBe("sk-from-file");
      expect(written.llm.openai.api_key).not.toBe("sk-from-env");
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  it("merges global and local config with local overrides winning", async () => {
    const homeDir = getJazzHomeDirectory();
    const globalPath = path.join(homeDir, "config.json");
    const localPath = path.join(process.cwd(), ".jazz", "config.json");

    const fileContents = new Map<string, string>([
      [globalPath, JSON.stringify({ logging: { level: "info" } })],
      [localPath, JSON.stringify({ logging: { level: "debug" } })],
    ]);

    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      const level = yield* config.get<string>("logging.level");
      const storagePath = yield* config.get<string>("storage.path");
      return { level, storagePath };
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.level).toBe("debug");
    expect(result.storagePath).toBe(homeDir);
  });

  it("ignores local storage.path overrides", async () => {
    const homeDir = getJazzHomeDirectory();
    const globalPath = path.join(homeDir, "config.json");
    const localPath = path.join(process.cwd(), ".jazz", "config.json");

    const fileContents = new Map<string, string>([
      [globalPath, JSON.stringify({ storage: { type: "file", path: homeDir } })],
      [
        localPath,
        JSON.stringify({ storage: { type: "file", path: path.join(process.cwd(), ".jazz") } }),
      ],
    ]);

    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      return yield* config.get<string>("storage.path");
    }).pipe(Effect.provide(layer));

    const storagePath = await Effect.runPromise(program);
    expect(storagePath).toBe(homeDir);
  });

  it("preserves custom global storage.path settings", async () => {
    const homeDir = getJazzHomeDirectory();
    const globalPath = path.join(homeDir, "config.json");
    const customStoragePath = path.join(homeDir, ".jazz-custom-storage");

    const fileContents = new Map<string, string>([
      [globalPath, JSON.stringify({ storage: { type: "file", path: customStoragePath } })],
    ]);

    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      return yield* config.get<string>("storage.path");
    }).pipe(Effect.provide(layer));

    const storagePath = await Effect.runPromise(program);
    expect(storagePath).toBe(customStoragePath);
  });

  it("merges local overrides when using a custom config path", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-custom-config.json");
    const localPath = path.join(process.cwd(), ".jazz", "config.json");

    const fileContents = new Map<string, string>([
      [customConfigPath, JSON.stringify({ logging: { level: "info" } })],
      [localPath, JSON.stringify({ logging: { level: "debug" } })],
    ]);

    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      return yield* config.get<string>("logging.level");
    }).pipe(Effect.provide(layer));

    const level = await Effect.runPromise(program);
    expect(level).toBe("debug");
  });

  it("preserves maxRetries and telemetry from a custom config file", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-retries-config.json");

    const fileContents = new Map<string, string>([
      [
        customConfigPath,
        JSON.stringify({
          maxRetries: 8,
          telemetry: { enabled: false },
        }),
      ],
    ]);

    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      const maxRetries = yield* config.get<number>("maxRetries");
      const telemetryEnabled = yield* config.get<boolean>("telemetry.enabled");
      return { maxRetries, telemetryEnabled };
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.maxRetries).toBe(8);
    expect(result.telemetryEnabled).toBe(false);
  });

  it("preserves maxSubagentDepth from a custom config file", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-subagent-depth-config.json");

    const fileContents = new Map<string, string>([
      [customConfigPath, JSON.stringify({ maxSubagentDepth: 1 })],
    ]);

    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      return yield* config.get<number>("maxSubagentDepth");
    }).pipe(Effect.provide(layer));

    expect(await Effect.runPromise(program)).toBe(1);
  });

  it("preserves both iteration budgets from a custom config file", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-iterations-config.json");

    const fileContents = new Map<string, string>([
      [customConfigPath, JSON.stringify({ maxIterations: 150, maxSubagentIterations: 12 })],
    ]);

    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      const maxIterations = yield* config.get<number>("maxIterations");
      const maxSubagentIterations = yield* config.get<number>("maxSubagentIterations");
      return { maxIterations, maxSubagentIterations };
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.maxIterations).toBe(150);
    expect(result.maxSubagentIterations).toBe(12);
  });

  it("leaves maxSubagentDepth unset when the config file omits it", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-subagent-depth-default.json");

    const fileContents = new Map<string, string>([
      [customConfigPath, JSON.stringify({ maxRetries: 3 })],
    ]);

    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      return yield* config.get<number>("maxSubagentDepth");
    }).pipe(Effect.provide(layer));

    expect(await Effect.runPromise(program)).toBeUndefined();
  });

  it("merges the telemetry.otlp block without dropping sibling telemetry settings", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-otlp-config.json");

    const fileContents = new Map<string, string>([
      [
        customConfigPath,
        JSON.stringify({
          telemetry: {
            retentionDays: 7,
            otlp: { endpoint: "http://collector:4318", captureContent: true },
          },
        }),
      ],
    ]);

    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const program = Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      const endpoint = yield* config.get<string>("telemetry.otlp.endpoint");
      const captureContent = yield* config.get<boolean>("telemetry.otlp.captureContent");
      const retentionDays = yield* config.get<number>("telemetry.retentionDays");
      return { endpoint, captureContent, retentionDays };
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.endpoint).toBe("http://collector:4318");
    expect(result.captureContent).toBe(true);
    expect(result.retentionDays).toBe(7);
  });

  function lastWrite(fs: FileSystem.FileSystem): Record<string, unknown> {
    const calls = (fs.writeFileString as ReturnType<typeof mock>).mock.calls;
    return JSON.parse(calls[calls.length - 1]?.[1] as string) as Record<string, unknown>;
  }

  it("loads every budget and scheduling setting a file sets", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-budgets-config.json");
    const settings = {
      maxCostUSD: 0.2,
      maxTokens: 200000,
      maxDurationMs: 1800000,
      workspaceMaxTotalBytesPerAgent: 1048576,
      scheduler: { mode: "in-process" },
    };
    const fileContents = new Map([[customConfigPath, JSON.stringify(settings)]]);

    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );
    const config = await Effect.runPromise(
      Effect.flatMap(AgentConfigServiceTag, (service) => service.appConfig).pipe(
        Effect.provide(layer),
      ),
    );

    expect(config).toMatchObject(settings);
  });

  it("keeps every valid setting a write did not touch", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map([
      [
        globalPath,
        JSON.stringify({
          maxCostUSD: 0.2,
          scheduler: { mode: "in-process" },
          maxRetries: 7,
        }),
      ],
    ]);
    const testFS = createTestFileSystem(fileContents);
    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
    );

    await Effect.runPromise(
      Effect.flatMap(AgentConfigServiceTag, (service) => service.set("maxRetries", 5)).pipe(
        Effect.provide(layer),
      ),
    );

    expect(lastWrite(testFS)).toEqual({
      maxCostUSD: 0.2,
      scheduler: { mode: "in-process" },
      maxRetries: 5,
    });
  });

  it("preserves ignored entries when writing a different setting", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map([[globalPath, JSON.stringify({ maxRetrys: 5, maxRetries: "7" })]]);
    const testFS = createTestFileSystem(fileContents);
    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
    );

    await captureStderr(() =>
      Effect.runPromise(
        Effect.flatMap(AgentConfigServiceTag, (service) =>
          service.set("notifications.enabled", false),
        ).pipe(Effect.provide(layer)),
      ),
    );

    expect(lastWrite(testFS)).toEqual({
      maxRetrys: 5,
      maxRetries: "7",
      notifications: { enabled: false },
    });
  });

  it("never copies project overrides, --debug, or defaults into the global file", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const localPath = path.join(process.cwd(), ".jazz", "config.json");
    const fileContents = new Map([
      [globalPath, JSON.stringify({ logging: { level: "warn" } })],
      [
        localPath,
        JSON.stringify({
          maxRetries: 9,
          llm: { ollama: { keep_alive: "-1" } },
          mcpServers: { "proj-only": { enabled: false } },
        }),
      ],
    ]);
    const testFS = createTestFileSystem(fileContents);
    const layer = createConfigLayer(true).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
    );

    const runtime = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentConfigServiceTag;
        yield* service.set("notifications.enabled", false);
        return yield* service.appConfig;
      }).pipe(Effect.provide(layer)),
    );

    expect(runtime.logging.level).toBe("debug");
    expect(runtime.maxRetries).toBe(9);
    expect(lastWrite(testFS)).toEqual({
      logging: { level: "warn" },
      notifications: { enabled: false },
    });
  });

  it("warns and uses valid siblings when an initial value has the wrong type", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-mistyped-config.json");
    const fileContents = new Map([
      [
        customConfigPath,
        JSON.stringify({ maxRetries: "5", output: { collapseReasoning: "false", mode: "raw" } }),
      ],
    ]);
    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );

    const { result: config, stderr } = await captureStderr(() =>
      Effect.runPromise(
        Effect.flatMap(AgentConfigServiceTag, (service) => service.appConfig).pipe(
          Effect.provide(layer),
        ),
      ),
    );

    expect(config.maxRetries).toBeUndefined();
    expect(config.output?.collapseReasoning).toBeUndefined();
    expect(config.output?.mode).toBe("raw");
    expect(stderr).toContain(customConfigPath);
    expect(stderr).toContain('maxRetries: expected a whole number of 0 or more, got "5"');
    expect(stderr).toContain("output.collapseReasoning: expected true or false");
  });

  it("warns and uses defaults when the initial file is malformed JSON", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-malformed-config.json");
    const fileContents = new Map([[customConfigPath, "{ broken"]]);
    const layer = createConfigLayer(undefined, customConfigPath).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );

    const { result: config, stderr } = await captureStderr(() =>
      Effect.runPromise(
        Effect.flatMap(AgentConfigServiceTag, (service) => service.appConfig).pipe(
          Effect.provide(layer),
        ),
      ),
    );

    expect(config.logging).toEqual({ level: "info", format: "plain" });
    expect(stderr).toContain(`Config file is not a valid JSON object: ${customConfigPath}`);
  });

  it("merges a project provider block into the global one field by field", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const localPath = path.join(process.cwd(), ".jazz", "config.json");
    const fileContents = new Map([
      [globalPath, JSON.stringify({ llm: { ollama: { base_url: "http://gpu-box:11434/api" } } })],
      [localPath, JSON.stringify({ llm: { ollama: { keep_alive: "-1" } } })],
    ]);
    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, createTestFileSystem(fileContents))),
    );

    const config = await Effect.runPromise(
      Effect.flatMap(AgentConfigServiceTag, (service) => service.appConfig).pipe(
        Effect.provide(layer),
      ),
    );

    expect(config.llm?.ollama).toEqual({ base_url: "http://gpu-box:11434/api", keep_alive: "-1" });
  });

  it("removes a setting from the file when it is cleared", async () => {
    const globalPath = path.join(getJazzHomeDirectory(), "config.json");
    const fileContents = new Map([
      [globalPath, JSON.stringify({ web_search: { provider: "brave" }, maxRetries: 2 })],
    ]);
    const testFS = createTestFileSystem(fileContents);
    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
    );

    await Effect.runPromise(
      Effect.flatMap(AgentConfigServiceTag, (service) =>
        service.set("web_search.provider", undefined),
      ).pipe(Effect.provide(layer)),
    );

    expect(lastWrite(testFS)).toEqual({ maxRetries: 2 });
  });
});

describe("validateConfigFiles", () => {
  it("fails explicitly on values normal startup would warn about and ignore", async () => {
    const customConfigPath = path.join(os.tmpdir(), "jazz-explicit-validation.json");
    const fs = {
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed(JSON.stringify({ maxRetries: "five" })),
    } as unknown as FileSystem.FileSystem;

    const exit = await Effect.runPromiseExit(
      validateConfigFiles(customConfigPath).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("maxRetries");
    }
  });
});

describe("AgentConfigService.set checks what callers hand it", () => {
  const initialConfig: AppConfig = {
    storage: { type: "file", path: "/tmp" },
    logging: { level: "info", format: "plain" },
  };

  it("dies rather than writing a value its setting cannot hold", async () => {
    const writeFileString = mock(() => Effect.void);
    const fs = { ...mockFS, writeFileString } as unknown as FileSystem.FileSystem;
    const service = new AgentConfigServiceImpl(initialConfig, {}, "/tmp/jazz-typed.json", fs);

    const exit = await Effect.runPromiseExit(service.set("maxRetries", "5"));

    expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true);
    expect(writeFileString).not.toHaveBeenCalled();
    expect(await Effect.runPromise(service.get("maxRetries"))).toBeUndefined();
  });

  it("merges an MCP server patch into that server's existing overrides", async () => {
    const writeFileString = mock(() => Effect.void);
    const fs = { ...mockFS, writeFileString } as unknown as FileSystem.FileSystem;
    const service = new AgentConfigServiceImpl(
      initialConfig,
      { mcpServers: { github: { enabled: false } } },
      "/tmp/jazz-mcp-patch.json",
      fs,
    );

    await Effect.runPromise(service.set("mcpServers.github", { trusted: true }));

    const calls = (writeFileString as ReturnType<typeof mock>).mock.calls;
    const written = JSON.parse(calls[0]?.[1] as string);
    expect(written.mcpServers.github).toEqual({ enabled: false, trusted: true });
  });

  it("patches a server whose name contains dots at the literal key, not a nested path", async () => {
    const writeFileString = mock(() => Effect.void);
    const fs = { ...mockFS, writeFileString } as unknown as FileSystem.FileSystem;
    const service = new AgentConfigServiceImpl(
      initialConfig,
      { mcpServers: { "com.example.mcp": { enabled: true } } },
      "/tmp/jazz-mcp-dotted.json",
      fs,
    );

    // `jazz mcp trust com.example.mcp` runs exactly this write; it used to die.
    await Effect.runPromise(service.set("mcpServers.com.example.mcp", { trusted: true }));

    const calls = (writeFileString as ReturnType<typeof mock>).mock.calls;
    const written = JSON.parse(calls[0]?.[1] as string);
    expect(written.mcpServers).toEqual({ "com.example.mcp": { enabled: true, trusted: true } });
  });

  it("does not commit the in-memory value when the atomic replace fails", async () => {
    const rename = mock(() => Effect.fail(new Error("disk full")));
    const fs = { ...mockFS, rename } as unknown as FileSystem.FileSystem;
    const service = new AgentConfigServiceImpl(
      { ...initialConfig, maxRetries: 2 },
      { maxRetries: 2 },
      "/tmp/jazz-failed-write.json",
      fs,
    );

    const exit = await Effect.runPromiseExit(service.set("maxRetries", 5));

    expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true);
    expect(await Effect.runPromise(service.get<number>("maxRetries"))).toBe(2);
    expect(await Effect.runPromise(service.revision)).toBe(0);
  });
});

describe("writes against the latest file", () => {
  it("preserves a valid external edit made after startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "jazz-write-latest-"));
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify({ maxRetries: 2 }));

    try {
      const layer = createConfigLayer(false, configPath).pipe(Layer.provide(NodeFileSystem.layer));
      await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* AgentConfigServiceTag;
          yield* Effect.promise(() =>
            writeFile(
              configPath,
              JSON.stringify({ maxRetries: 2, notifications: { sound: true } }),
            ),
          );
          yield* service.set("maxRetries", 5);
        }).pipe(Effect.provide(layer)),
      );

      const written = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      expect(written).toEqual({ maxRetries: 5, notifications: { sound: true } });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a file that became malformed after startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "jazz-write-invalid-"));
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify({ maxRetries: 2 }));

    try {
      const layer = createConfigLayer(false, configPath).pipe(Layer.provide(NodeFileSystem.layer));
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const service = yield* AgentConfigServiceTag;
          yield* Effect.promise(() => writeFile(configPath, "{ broken"));
          yield* service.set("maxRetries", 5);
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true);
      expect(await Bun.file(configPath).text()).toBe("{ broken");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("noticing an edit made by another process", () => {
  it("picks up a webhook added to the file after startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "jazz-reload-"));
    const configPath = join(home, "config.json");
    const write = (webhooks: { name: string; agentId: string; promptTemplate: string }[]) =>
      writeFile(configPath, JSON.stringify({ webhooks }));

    await write([{ name: "first", agentId: "a", promptTemplate: "x" }]);

    const layer = createConfigLayer(false, configPath).pipe(Layer.provide(NodeFileSystem.layer));

    const program = Effect.gen(function* () {
      const service = yield* AgentConfigServiceTag;
      const before = ((yield* service.appConfig).webhooks ?? []).length;

      // Something else edits the file — a setup tool, or an operator with an editor. The
      // mtime has one-second resolution on some filesystems, so move it on explicitly.
      yield* Effect.promise(async () => {
        await write([
          { name: "first", agentId: "a", promptTemplate: "x" },
          { name: "second", agentId: "b", promptTemplate: "y" },
        ]);
        const later = new Date(Date.now() + 2_000);
        await utimes(configPath, later, later);
      });

      const stale = ((yield* service.appConfig).webhooks ?? []).length;
      const changed = yield* service.reloadIfChanged();
      const after = ((yield* service.appConfig).webhooks ?? []).length;
      return { before, stale, changed, after };
    });

    const result = await Effect.runPromise(
      Effect.provide(program, layer) as Effect.Effect<
        { before: number; stale: number; changed: boolean; after: number },
        never,
        never
      >,
    );

    expect(result.before).toBe(1);
    // `appConfig` answers from memory, which is the whole reason a reload is needed.
    expect(result.stale).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.after).toBe(2);

    await rm(home, { recursive: true, force: true });
  });

  it("keeps the last-known-good view across an invalid edit, then accepts the repair", async () => {
    const home = await mkdtemp(join(tmpdir(), "jazz-reload-invalid-"));
    const configPath = join(home, "config.json");
    await writeFile(configPath, JSON.stringify({ maxRetries: 2 }));

    try {
      const layer = createConfigLayer(false, configPath).pipe(Layer.provide(NodeFileSystem.layer));
      const { result, stderr } = await captureStderr(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* AgentConfigServiceTag;
            yield* Effect.promise(async () => {
              await writeFile(configPath, JSON.stringify({ maxRetries: "bad" }));
              const later = new Date(Date.now() + 2_000);
              await utimes(configPath, later, later);
            });
            const invalidChanged = yield* service.reloadIfChanged();
            const afterInvalid = yield* service.get<number>("maxRetries");

            yield* Effect.promise(async () => {
              await writeFile(configPath, JSON.stringify({ maxRetries: 4 }));
              const later = new Date(Date.now() + 4_000);
              await utimes(configPath, later, later);
            });
            const repairedChanged = yield* service.reloadIfChanged();
            const afterRepair = yield* service.get<number>("maxRetries");
            return { invalidChanged, afterInvalid, repairedChanged, afterRepair };
          }).pipe(Effect.provide(layer)),
        ),
      );

      expect(result).toEqual({
        invalidChanged: false,
        afterInvalid: 2,
        repairedChanged: true,
        afterRepair: 4,
      });
      expect(stderr).toContain("keeping the last-known-good configuration");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
