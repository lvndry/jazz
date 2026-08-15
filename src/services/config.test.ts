import os from "node:os";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { AgentConfigServiceImpl, createConfigLayer } from "./config";
import { type AppConfig } from "../core/types/index";

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
} as unknown as FileSystem;

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

  it("should set properties and persist to file", async () => {
    const configPath = "/tmp/config.json";
    const service = new AgentConfigServiceImpl(initialConfig, {}, configPath, mockFS);

    await Effect.runPromise(service.set("llm.openai.api_key", "sk-test"));

    const key = await Effect.runPromise(service.get("llm.openai.api_key"));
    expect(key).toBe("sk-test");
    expect(mockFS.writeFileString).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining("sk-test"),
      { mode: 0o600 },
    );
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
    expect(dirCalls[dirCalls.length - 1]?.[1]).toEqual({ recursive: true, mode: 0o700 });
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
    const mcpOverrides = { testServer: { enabled: true as const } };
    const service = new AgentConfigServiceImpl(configWithMcp, mcpOverrides, configPath, mockFS);

    await Effect.runPromise(service.set("mcpServers.testServer.enabled", false));

    expect(mockFS.writeFileString).toHaveBeenCalled();
    const calls = (mockFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    const written = calls[calls.length - 1]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.testServer).toEqual({ enabled: false });
    expect(parsed.mcpServers.testServer.command).toBeUndefined();
  });
});

describe("createConfigLayer", () => {
  function createTestFileSystem(fileContents: Map<string, string>): FileSystem {
    return {
      exists: (filePath: string) => Effect.succeed(fileContents.has(filePath)),
      readFileString: (filePath: string) => Effect.succeed(fileContents.get(filePath) ?? ""),
      writeFileString: mock(() => Effect.void),
      makeDirectory: mock(() => Effect.void),
    } as unknown as FileSystem;
  }

  it("removes the legacy google client block from the config file", async () => {
    const globalPath = path.join(os.homedir(), ".jazz", "config.json");
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

  it("leaves a repurposed google block alone", async () => {
    const globalPath = path.join(os.homedir(), ".jazz", "config.json");
    const fileContents = new Map<string, string>([
      [globalPath, JSON.stringify({ google: { somethingElse: "keep-me" } })],
    ]);
    const testFS = createTestFileSystem(fileContents);

    const layer = createConfigLayer().pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, testFS)),
    );
    await Effect.runPromise(Effect.provide(AgentConfigServiceTag, layer));

    const calls = (testFS.writeFileString as ReturnType<typeof mock>).mock.calls;
    expect(calls.length).toBe(0);
  });

  it("resolves secrets from the environment over the config file", async () => {
    const globalPath = path.join(os.homedir(), ".jazz", "config.json");
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
    const globalPath = path.join(os.homedir(), ".jazz", "config.json");
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
    const globalPath = path.join(os.homedir(), ".jazz", "config.json");
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
    const homeDir = os.homedir();
    const globalPath = path.join(homeDir, ".jazz", "config.json");
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
    expect(result.storagePath).toBe(path.join(homeDir, ".jazz"));
  });

  it("ignores local storage.path overrides", async () => {
    const homeDir = os.homedir();
    const globalPath = path.join(homeDir, ".jazz", "config.json");
    const localPath = path.join(process.cwd(), ".jazz", "config.json");

    const fileContents = new Map<string, string>([
      [
        globalPath,
        JSON.stringify({ storage: { type: "file", path: path.join(homeDir, ".jazz") } }),
      ],
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
    expect(storagePath).toBe(path.join(homeDir, ".jazz"));
  });

  it("preserves custom global storage.path settings", async () => {
    const homeDir = os.homedir();
    const globalPath = path.join(homeDir, ".jazz", "config.json");
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
});
