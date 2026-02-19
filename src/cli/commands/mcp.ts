import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { z } from "zod";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { writeAgentsMcpServer, removeAgentsMcpServer } from "@/services/config";

type McpServersRecord = Record<string, MCPServerConfig>;

const StdioServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const HttpServerConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const McpServerConfigSchema = z.union([HttpServerConfigSchema, StdioServerConfigSchema]);

const McpServersInputSchema = z.record(z.string(), McpServerConfigSchema);

/**
 * Parse and validate MCP server JSON, then save to ~/.agents/mcp.json
 * and set enabled: true in jazz.config.json.
 */
function parseAndSaveMcpServers(
  input: string,
): Effect.Effect<void, never, AgentConfigService | TerminalService | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const fs = yield* FileSystem.FileSystem;

    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      yield* terminal.error("Invalid JSON. Please provide a valid JSON object.");
      return;
    }

    const result = McpServersInputSchema.safeParse(parsed);

    if (!result.success) {
      const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
      yield* terminal.error(`Invalid MCP server configuration:\n${issues.join("\n")}`);
      return;
    }

    const entries = Object.entries(result.data);

    if (entries.length === 0) {
      yield* terminal.warn("No servers found in the provided JSON.");
      return;
    }

    for (const [name, config] of entries) {
      // Strip enabled — metadata lives in jazz.config.json, not mcp.json
      const { enabled: _, ...serverConfig } = config;

      // Write full server config to ~/.agents/mcp.json
      yield* writeAgentsMcpServer(fs, name, serverConfig);

      // Set enabled in jazz.config.json (enabled by default on add)
      yield* configService.set(`mcpServers.${name}`, { enabled: true });

      yield* terminal.success(`Added MCP server: ${name}`);
    }
  });
}

/**
 * Read all data from stdin (for piped input)
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

/**
 * Add an MCP server from JSON (inline argument, --file, stdin pipe, or interactive prompt)
 *
 * Writes the full server config to ~/.agents/mcp.json and sets enabled: true
 * in jazz.config.json.
 *
 * Usage:
 *   jazz mcp add '{"name": {"command": "..."}}'
 *   jazz mcp add --file server.json
 *   pbpaste | jazz mcp add
 *   cat server.json | jazz mcp add
 */
export function addMcpServerCommand(
  jsonArg?: string,
  filePath?: string,
): Effect.Effect<void, never, AgentConfigService | TerminalService | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const fs = yield* FileSystem.FileSystem;

    // 1. From --file
    if (filePath) {
      const contentOpt = yield* fs.readFileString(filePath).pipe(Effect.option);
      if (Option.isNone(contentOpt)) {
        yield* terminal.error(`Could not read file: ${filePath}`);
        return;
      }
      return yield* parseAndSaveMcpServers(contentOpt.value);
    }

    // 2. From inline JSON argument
    if (jsonArg) {
      return yield* parseAndSaveMcpServers(jsonArg);
    }

    // 3. From stdin pipe (e.g. pbpaste | jazz mcp add)
    if (!process.stdin.isTTY) {
      const stdinContent = yield* Effect.tryPromise({
        try: () => readStdin(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
      if (stdinContent.trim() === "") {
        yield* terminal.warn("No input received from stdin.");
        return;
      }
      return yield* parseAndSaveMcpServers(stdinContent);
    }

    // 4. Interactive — open $EDITOR with a temp file
    const editor = process.env["EDITOR"] || process.env["VISUAL"] || "vi";
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `jazz-mcp-${Date.now()}.json`);

    const template = `{
  "server-name": {
    "command": "your-command",
    "args": []
  }
}
`;
    yield* fs.writeFileString(tmpFile, template).pipe(Effect.catchAll(() => Effect.void));

    yield* terminal.info(`Opening ${editor} to edit MCP server configuration...`);

    try {
      execSync(`${editor} "${tmpFile}"`, { stdio: "inherit" });
    } catch {
      yield* fs.remove(tmpFile).pipe(Effect.catchAll(() => Effect.void));
      yield* terminal.error(
        `Failed to open editor (${editor}). Set $EDITOR or use --file instead.`,
      );
      return;
    }

    const contentOpt = yield* fs.readFileString(tmpFile).pipe(Effect.option);
    yield* fs.remove(tmpFile).pipe(Effect.catchAll(() => Effect.void));

    if (Option.isNone(contentOpt)) {
      yield* terminal.error("Could not read temp file after editing.");
      return;
    }

    const content = contentOpt.value;
    if (content.trim() === "" || content.trim() === template.trim()) {
      yield* terminal.warn("No changes made. Aborting.");
      return;
    }

    return yield* parseAndSaveMcpServers(content);
  });
}

/**
 * List all configured MCP servers.
 *
 * Shows the merged view: full configs from .agents/mcp.json with
 * enable/disable status from jazz.config.json.
 */
export function listMcpServersCommand(): Effect.Effect<
  void,
  never,
  AgentConfigService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    // At runtime, mcpServers is the merged view (full configs + overrides)
    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const entries = Object.entries(mcpServers);

    if (entries.length === 0) {
      yield* terminal.info("No MCP servers configured.");
      return;
    }

    yield* terminal.heading("MCP Servers");

    for (const [name, config] of entries) {
      const enabled = config.enabled !== false;
      const status = enabled ? "enabled" : "disabled";
      const transport = "command" in config ? `stdio: ${config.command}` : "http";

      yield* terminal.log(`  ${name} (${transport}) [${status}]`);
    }
  });
}

/**
 * Remove an MCP server interactively.
 *
 * Removes the server from ~/.agents/mcp.json and cleans up
 * any enable/disable metadata from jazz.config.json.
 */
export function removeMcpServerCommand(): Effect.Effect<
  void,
  never,
  AgentConfigService | TerminalService | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const fs = yield* FileSystem.FileSystem;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const names = Object.keys(mcpServers);

    if (names.length === 0) {
      yield* terminal.info("No MCP servers to remove.");
      return;
    }

    const selected = yield* terminal.select<string>("Select a server to remove:", {
      choices: names.map((name) => ({ name, value: name })),
    });

    if (!selected) {
      yield* terminal.info("Cancelled.");
      return;
    }

    const confirmed = yield* terminal.confirm(`Remove server "${selected}"?`, false);

    if (!confirmed) {
      yield* terminal.info("Cancelled.");
      return;
    }

    // Remove from ~/.agents/mcp.json (user-level). If server was project-only, it stays in mcp.json
    // but we add enabled: false to jazz overrides to effectively hide it.
    yield* removeAgentsMcpServer(fs, selected);

    // Build overrides: for remaining servers keep their enabled; for removed server add enabled: false
    const overrides: Record<string, { enabled?: boolean }> = {};
    for (const [n, c] of Object.entries(mcpServers)) {
      const o: { enabled?: boolean } = {};
      if (n === selected) {
        o.enabled = false;
      } else if (c.enabled !== undefined) {
        o.enabled = c.enabled;
      }
      if (Object.keys(o).length > 0) overrides[n] = o;
    }
    yield* configService.set("mcpServers", overrides);

    yield* terminal.success(`Removed MCP server: ${selected}`);
  });
}

/**
 * Enable a disabled MCP server interactively.
 *
 * Sets enabled: true (or removes the override) in jazz.config.json.
 */
export function enableMcpServerCommand(): Effect.Effect<
  void,
  never,
  AgentConfigService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const disabledServers = Object.entries(mcpServers).filter(
      ([, config]) => config.enabled === false,
    );

    if (disabledServers.length === 0) {
      yield* terminal.info("No disabled MCP servers to enable.");
      return;
    }

    const selected = yield* terminal.select<string>("Select a server to enable:", {
      choices: disabledServers.map(([name]) => ({ name, value: name })),
    });

    if (!selected) {
      yield* terminal.info("Cancelled.");
      return;
    }

    yield* configService.set(`mcpServers.${selected}`, { enabled: true });
    yield* terminal.success(`Enabled MCP server: ${selected}`);
  });
}

/**
 * Disable an enabled MCP server interactively.
 *
 * Sets enabled: false in jazz.config.json.
 */
export function disableMcpServerCommand(): Effect.Effect<
  void,
  never,
  AgentConfigService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const enabledServers = Object.entries(mcpServers).filter(
      ([, config]) => config.enabled !== false,
    );

    if (enabledServers.length === 0) {
      yield* terminal.info("No enabled MCP servers to disable.");
      return;
    }

    const selected = yield* terminal.select<string>("Select a server to disable:", {
      choices: enabledServers.map(([name]) => ({ name, value: name })),
    });

    if (!selected) {
      yield* terminal.info("Cancelled.");
      return;
    }

    yield* configService.set(`mcpServers.${selected}`, { enabled: false });
    yield* terminal.success(`Disabled MCP server: ${selected}`);
  });
}
