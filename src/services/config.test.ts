import { type FileSystem } from "@effect/platform/FileSystem";
import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { AgentConfigServiceImpl } from "./config";
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
    const configWithMcp = {
      ...initialConfig,
      mcpServers: {
        testServer: {
          command: "npx",
          args: ["-y", "some-mcp"],
          enabled: true,
        },
      },
    } as AppConfig;
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
