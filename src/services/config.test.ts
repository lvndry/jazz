import { FileSystem } from "@effect/platform";
import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentConfigServiceImpl, createConfigLayer } from "./config";
import { AgentConfigServiceTag } from "../core/interfaces/agent-config";
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
} as unknown as FileSystem.FileSystem;

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

  it("should round-trip unlimited flag through save and load", async () => {
    let written = "";
    const capturingFS = {
      ...mockFS,
      writeFileString: mock((_path: string, content: string) => {
        written = content;
        return Effect.void;
      }),
      readFileString: mock(() => Effect.succeed(written)),
    } as unknown as FileSystem.FileSystem;

    const configPath = "/tmp/jazz-unlimited-test.json";
    const configWithUnlimited: AppConfig = {
      ...initialConfig,
      unlimited: true,
    };
    const service = new AgentConfigServiceImpl(configWithUnlimited, {}, configPath, capturingFS);

    await Effect.runPromise(service.set("unlimited", true));

    expect(JSON.parse(written).unlimited).toBe(true);

    const reloaded = await Effect.runPromise(service.get<boolean>("unlimited"));
    expect(reloaded).toBe(true);
  });

  it("should load unlimited flag from config file via mergeConfig", async () => {
    const configPath = "/tmp/jazz-unlimited-load-test.json";
    const fileContent = JSON.stringify({ unlimited: true });

    const loadFS = {
      ...mockFS,
      exists: mock((path: string) => Effect.succeed(path === configPath)),
      readFileString: mock((path: string) =>
        path === configPath ? Effect.succeed(fileContent) : Effect.succeed(""),
      ),
    } as unknown as FileSystem.FileSystem;

    const fsLayer = Layer.succeed(FileSystem.FileSystem, loadFS);
    const configLayer = createConfigLayer(false, configPath);

    const unlimitedValue = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* AgentConfigServiceTag;
        return yield* config.get<boolean>("unlimited");
      }).pipe(Effect.provide(configLayer), Effect.provide(fsLayer)),
    );

    expect(unlimitedValue).toBe(true);
  });
});
