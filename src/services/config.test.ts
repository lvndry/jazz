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
    google: { clientId: "", clientSecret: "" },
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
    );
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
});
