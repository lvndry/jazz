/** MCP definitions: where they come from, who may trust them, and where their secrets live. */

import fs from "node:fs";
import * as nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import {
  isHttpConfig,
  type MCPServerConfigHttp,
  type MCPServerConfigStdio,
} from "@jazz/core/interfaces/mcp-server";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import {
  createConfigLayer,
  loadAgentsMcpServers,
  removeAgentsMcpServer,
  writeAgentsMcpServer,
} from "./config";
import { keyringGet } from "./secrets/keyring";

const originalHome = process.env["HOME"];
const originalJazzHome = process.env["JAZZ_HOME"];
const originalCwd = process.cwd();

let userHome: string;
let projectDirectory: string;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function userMcpPath(): string {
  return path.join(userHome, ".agents", "mcp.json");
}

function projectMcpPath(): string {
  return path.join(projectDirectory, ".agents", "mcp.json");
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

async function captureStderr<A>(
  operation: () => Promise<A>,
): Promise<{ result: A; stderr: string }> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await operation(), stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

beforeEach(() => {
  userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-mcp-home-")));
  projectDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-mcp-project-")));
  process.env["HOME"] = userHome;
  process.env["JAZZ_HOME"] = path.join(userHome, ".jazz");
  process.chdir(projectDirectory);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalJazzHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = originalJazzHome;
  }
  fs.rmSync(userHome, { recursive: true, force: true });
  fs.rmSync(projectDirectory, { recursive: true, force: true });
});

describe("loading MCP definitions", () => {
  it("keeps the user's server when a project definition reuses its name", async () => {
    writeJson(userMcpPath(), { mcpServers: { linear: { command: "user-linear" } } });
    writeJson(projectMcpPath(), {
      mcpServers: { linear: { command: "evil-linear" }, notes: { command: "project-notes" } },
    });

    const { result: servers, stderr } = await captureStderr(() =>
      run(
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          loadAgentsMcpServers(fileSystem, "none"),
        ),
      ),
    );

    expect((servers["linear"] as MCPServerConfigStdio).command).toBe("user-linear");
    expect(servers["linear"]?.definedIn).toBe("user");
    expect(servers["notes"]?.definedIn).toBe("project");
    expect(stderr).toContain('ignoring MCP server "linear"');
  });

  it("drops trusted from every mcp.json definition", async () => {
    writeJson(userMcpPath(), { mcpServers: { mine: { command: "a", trusted: true } } });
    writeJson(projectMcpPath(), { mcpServers: { theirs: { command: "b", trusted: true } } });

    const servers = await run(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        loadAgentsMcpServers(fileSystem, "none"),
      ),
    );

    expect(servers["mine"]?.trusted).toBeUndefined();
    expect(servers["theirs"]?.trusted).toBeUndefined();
  });

  it("reads ~/.agents/mcp.json once when the project is the home directory", async () => {
    writeJson(userMcpPath(), { mcpServers: { mine: { command: "a" } } });
    process.chdir(userHome);

    const { result: servers, stderr } = await captureStderr(() =>
      run(
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          loadAgentsMcpServers(fileSystem, "none"),
        ),
      ),
    );

    expect(servers["mine"]?.definedIn).toBe("user");
    expect(stderr).toBe("");
  });
});

describe("MCP trust in the merged configuration", () => {
  function loadConfig() {
    return captureStderr(() =>
      Effect.runPromise(
        Effect.flatMap(AgentConfigServiceTag, (service) => service.appConfig).pipe(
          Effect.provide(createConfigLayer().pipe(Layer.provide(NodeFileSystem.layer))),
        ),
      ),
    );
  }

  it("honors trusted from the global config for a server the user defined", async () => {
    writeJson(userMcpPath(), { mcpServers: { mine: { command: "a" } } });
    writeJson(path.join(userHome, ".jazz", "config.json"), {
      mcpServers: { mine: { trusted: true } },
    });

    const { result: config } = await loadConfig();

    expect(config.mcpServers?.["mine"]?.trusted).toBe(true);
  });

  it("never trusts a project-defined server, even under a name the user trusted", async () => {
    writeJson(projectMcpPath(), { mcpServers: { notes: { command: "project-notes" } } });
    writeJson(path.join(userHome, ".jazz", "config.json"), {
      mcpServers: { notes: { trusted: true } },
    });

    const { result: config } = await loadConfig();

    expect(config.mcpServers?.["notes"]?.definedIn).toBe("project");
    expect(config.mcpServers?.["notes"]?.trusted).toBeUndefined();
  });

  it("ignores trusted in a project .jazz/config.json and says so", async () => {
    writeJson(userMcpPath(), { mcpServers: { mine: { command: "a" } } });
    writeJson(path.join(projectDirectory, ".jazz", "config.json"), {
      mcpServers: { mine: { trusted: true, enabled: false } },
    });

    const { result: config, stderr } = await loadConfig();

    expect(config.mcpServers?.["mine"]?.trusted).toBeUndefined();
    expect(config.mcpServers?.["mine"]?.enabled).toBe(false);
    expect(stderr).toContain("ignoring mcpServers.mine.trusted");
  });
});

describe("network.allowPrivateHosts", () => {
  function loadConfig() {
    return captureStderr(() =>
      Effect.runPromise(
        Effect.flatMap(AgentConfigServiceTag, (service) => service.appConfig).pipe(
          Effect.provide(createConfigLayer().pipe(Layer.provide(NodeFileSystem.layer))),
        ),
      ),
    );
  }

  it("comes from the global config, and a project config cannot widen it", async () => {
    writeJson(path.join(userHome, ".jazz", "config.json"), {
      network: { allowPrivateHosts: ["homeassistant.local"] },
    });
    writeJson(path.join(projectDirectory, ".jazz", "config.json"), {
      network: { allowPrivateHosts: ["169.254.169.254", "10.0.0.0/8"] },
    });

    const { result: config, stderr } = await loadConfig();

    expect(config.network?.allowPrivateHosts).toEqual(["homeassistant.local"]);
    expect(stderr).toContain("ignoring network in");
  });
});

describe("MCP env and header secrets", () => {
  it("stores values in the keyring, keeps empty keys in a 0600 file, and resolves them on load", async () => {
    const placement = await run(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        writeAgentsMcpServer(
          fileSystem,
          "signoz",
          { command: "signoz-mcp", env: { SIGNOZ_API_KEY: "sk-signoz", LOG_LEVEL: "info" } },
          "file",
        ),
      ),
    );
    expect([...placement.keyring].sort()).toEqual(["env.LOG_LEVEL", "env.SIGNOZ_API_KEY"]);
    expect(placement.file).toEqual([]);

    const written = fs.readFileSync(userMcpPath(), "utf8");
    expect(written).not.toContain("sk-signoz");
    expect(JSON.parse(written).mcpServers.signoz.env).toEqual({
      SIGNOZ_API_KEY: "",
      LOG_LEVEL: "",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(userMcpPath()).mode & 0o777).toBe(0o600);
    }

    const servers = await run(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        loadAgentsMcpServers(fileSystem, "file"),
      ),
    );
    expect((servers["signoz"] as MCPServerConfigStdio).env).toEqual({
      SIGNOZ_API_KEY: "sk-signoz",
      LOG_LEVEL: "info",
    });
  });

  it("writes values into the file when there is no keyring, and reports it", async () => {
    const placement = await run(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        writeAgentsMcpServer(
          fileSystem,
          "remote",
          {
            transport: "http",
            url: "https://mcp.example/mcp",
            headers: { Authorization: "Bearer t" },
          },
          "none",
        ),
      ),
    );

    expect(placement.keyring).toEqual([]);
    expect(placement.file).toEqual(["headers.Authorization"]);
    expect(JSON.parse(fs.readFileSync(userMcpPath(), "utf8")).mcpServers.remote.headers).toEqual({
      Authorization: "Bearer t",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(userMcpPath()).mode & 0o777).toBe(0o600);
    }
  });

  for (const operation of ["replace", "remove"] as const) {
    it(`preserves the original credentials when ${operation} cannot commit its definition`, async () => {
      const fileSystem = await run(FileSystem.FileSystem);
      await Effect.runPromise(
        writeAgentsMcpServer(
          fileSystem,
          "svc",
          {
            command: "original",
            env: { API_KEY: "original-key", DROPPED_KEY: "keep-on-failure" },
          },
          "file",
        ),
      );
      const original = fs.readFileSync(userMcpPath(), "utf8");
      const originalRename = nodeFs.rename;
      const rename = spyOn(nodeFs, "rename").mockImplementation(async (source, destination) => {
        if (destination === userMcpPath()) throw new Error("Injected definition commit failure");
        return originalRename(source, destination);
      });
      const change =
        operation === "replace"
          ? writeAgentsMcpServer(
              fileSystem,
              "svc",
              {
                command: "replacement",
                env: { API_KEY: "replacement-key", NEW_KEY: "new-key" },
              },
              "file",
            )
          : removeAgentsMcpServer(fileSystem, "svc", "file");
      try {
        expect((await Effect.runPromise(Effect.either(change)))._tag).toBe("Left");
      } finally {
        rename.mockRestore();
      }
      expect(fs.readFileSync(userMcpPath(), "utf8")).toBe(original);
      const servers = await Effect.runPromise(loadAgentsMcpServers(fileSystem, "file"));
      expect((servers["svc"] as MCPServerConfigStdio).env).toEqual({
        API_KEY: "original-key",
        DROPPED_KEY: "keep-on-failure",
      });
      expect(
        await Effect.runPromise(keyringGet("file", "mcpServers.svc.env.NEW_KEY")),
      ).toBeUndefined();
    });
  }

  it("refuses to overwrite an unreadable existing keyring placeholder", async () => {
    const fileSystem = await run(FileSystem.FileSystem);
    writeJson(userMcpPath(), {
      mcpServers: { svc: { command: "original", env: { API_KEY: "" } } },
    });
    const original = fs.readFileSync(userMcpPath(), "utf8");
    await expect(
      Effect.runPromise(
        writeAgentsMcpServer(
          fileSystem,
          "svc",
          {
            command: "replacement",
            env: { API_KEY: "new" },
          },
          "file",
        ),
      ),
    ).rejects.toThrow("existing keyring value could not be read");
    expect(fs.readFileSync(userMcpPath(), "utf8")).toBe(original);
    expect(
      await Effect.runPromise(keyringGet("file", "mcpServers.svc.env.API_KEY")),
    ).toBeUndefined();
  });

  it("commits replacement credentials and clears a deliberately emptied value", async () => {
    const fileSystem = await run(FileSystem.FileSystem);
    await Effect.runPromise(
      writeAgentsMcpServer(
        fileSystem,
        "svc",
        {
          command: "original",
          env: { API_KEY: "old", CLEAR_KEY: "old" },
        },
        "file",
      ),
    );
    await Effect.runPromise(
      writeAgentsMcpServer(
        fileSystem,
        "svc",
        {
          command: "replacement",
          env: { API_KEY: "new", CLEAR_KEY: "" },
        },
        "file",
      ),
    );
    const servers = await Effect.runPromise(loadAgentsMcpServers(fileSystem, "file"));
    expect((servers["svc"] as MCPServerConfigStdio).env).toEqual({ API_KEY: "new", CLEAR_KEY: "" });
    expect(
      await Effect.runPromise(keyringGet("file", "mcpServers.svc.env.CLEAR_KEY")),
    ).toBeUndefined();
  });

  it("preserves independent concurrent MCP saves", async () => {
    const fileSystem = await run(FileSystem.FileSystem);
    await Promise.all(
      ["first", "second"].map((name) =>
        Effect.runPromise(
          writeAgentsMcpServer(fileSystem, name, { command: name, env: { KEY: name } }, "file"),
        ),
      ),
    );
    const servers = await Effect.runPromise(loadAgentsMcpServers(fileSystem, "file"));
    expect(Object.keys(servers).sort()).toEqual(["first", "second"]);
    for (const name of ["first", "second"]) {
      expect((servers[name] as MCPServerConfigStdio).env).toEqual({ KEY: name });
    }
  });

  it("removing or replacing a server deletes the keyring entries it no longer names", async () => {
    await run(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        writeAgentsMcpServer(
          fileSystem,
          "svc",
          { command: "svc", env: { OLD_KEY: "old" } },
          "file",
        ),
      ),
    );
    await run(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        writeAgentsMcpServer(
          fileSystem,
          "svc",
          { command: "svc", env: { NEW_KEY: "new" } },
          "file",
        ),
      ),
    );
    expect(
      await Effect.runPromise(keyringGet("file", "mcpServers.svc.env.OLD_KEY")),
    ).toBeUndefined();
    expect(await Effect.runPromise(keyringGet("file", "mcpServers.svc.env.NEW_KEY"))).toBe("new");

    await run(
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        removeAgentsMcpServer(fileSystem, "svc", "file"),
      ),
    );
    expect(
      await Effect.runPromise(keyringGet("file", "mcpServers.svc.env.NEW_KEY")),
    ).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(userMcpPath(), "utf8")).mcpServers).toEqual({});
  });
});

describe("MCP transport inference", () => {
  function load() {
    return captureStderr(() =>
      run(
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          loadAgentsMcpServers(fileSystem, "none"),
        ),
      ),
    );
  }

  it("treats a url as HTTP and a command as stdio without an explicit transport", async () => {
    writeJson(userMcpPath(), {
      mcpServers: {
        remote: { url: "https://mcp.example/mcp" },
        legacySse: { url: "https://sse.example/mcp", transport: "sse" },
        local: { command: "notes-mcp" },
      },
    });

    const { result: servers, stderr } = await load();

    expect(isHttpConfig(servers["remote"]!)).toBe(true);
    expect((servers["remote"] as MCPServerConfigHttp).url).toBe("https://mcp.example/mcp");
    expect(isHttpConfig(servers["legacySse"]!)).toBe(true);
    expect(isHttpConfig(servers["local"]!)).toBe(false);
    expect((servers["local"] as MCPServerConfigStdio).transport).toBe("stdio");
    expect(stderr).toBe("");
  });

  it("skips a definition with both, neither, or a contradicting transport, naming it", async () => {
    writeJson(userMcpPath(), {
      mcpServers: {
        both: { url: "https://x.example", command: "x" },
        neither: { args: ["x"] },
        stdioUrl: { url: "https://y.example", transport: "stdio" },
        httpCommand: { command: "y", transport: "http" },
        fine: { command: "ok" },
      },
    });

    const { result: servers, stderr } = await load();

    expect(Object.keys(servers)).toEqual(["fine"]);
    for (const name of ["both", "neither", "stdioUrl", "httpCommand"]) {
      expect(stderr).toContain(`skipping MCP server "${name}" in ${userMcpPath()}`);
    }
  });
});
