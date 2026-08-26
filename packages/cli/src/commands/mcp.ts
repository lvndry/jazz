/**
 * `jazz mcp` — add, remove, list, and test MCP servers.
 *
 * Server config is split across two files: the full server definition lives in
 * ~/.agents/mcp.json (shared with other MCP-aware tools), while jazz-specific
 * flags (enabled, trusted) live in ~/.jazz/config.json.
 */

import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { writeAgentsMcpServer, removeAgentsMcpServer } from "@jazz/adapters/config";
import { authorizeServer, clearServerAuth, hasStoredAuth } from "@jazz/adapters/mcp/oauth";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { LoggerService } from "@jazz/core/interfaces/logger";
import {
  isHttpConfig,
  MCPServerManagerTag,
  type MCPServerConfig,
  type MCPServerManager,
} from "@jazz/core/interfaces/mcp-server";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { Effect, Option } from "effect";
import { z } from "zod";
import * as fmt from "@/cli/utils/list-format";

type McpServersRecord = Record<string, MCPServerConfig>;

/** How many resource URIs `mcp test` prints before summarising the rest. */
const RESOURCE_PREVIEW_LIMIT = 10;

/** Services every MCP CLI command needs. */
type McpCommandDeps = AgentConfigService | TerminalService | FileSystem.FileSystem;

/** Commands that actually talk to a server also need the manager and logger. */
type McpLiveDeps = McpCommandDeps | MCPServerManager | LoggerService;

const StdioServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  trusted: z.boolean().optional(),
});

const HttpServerConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  trusted: z.boolean().optional(),
});

const McpServerConfigSchema = z.union([HttpServerConfigSchema, StdioServerConfigSchema]);

const McpServersInputSchema = z.record(z.string(), McpServerConfigSchema);

/**
 * Persist one server: full config to ~/.agents/mcp.json, and the bits Jazz owns
 * (enabled, trusted) to ~/.jazz/config.json.
 */
function saveServer(
  fs: FileSystem.FileSystem,
  configService: AgentConfigService,
  name: string,
  config: Record<string, unknown>,
  trusted: boolean,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const { enabled: _enabled, trusted: _trusted, ...serverConfig } = config;
    yield* writeAgentsMcpServer(fs, name, serverConfig);
    yield* configService.set(`mcpServers.${name}`, { enabled: true, trusted });
  });
}

/**
 * Parse and validate MCP server JSON, then save to ~/.agents/mcp.json
 * and set enabled: true in ~/.jazz/config.json.
 */
function parseAndSaveMcpServers(
  input: string,
  trusted: boolean,
): Effect.Effect<void, never, McpCommandDeps> {
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
      const issues = result.error.issues.map(
        (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
      );
      yield* terminal.error(`Invalid MCP server configuration:\n${issues.join("\n")}`);
      return;
    }

    const entries = Object.entries(result.data);

    if (entries.length === 0) {
      yield* terminal.warn("No servers found in the provided JSON.");
      return;
    }

    for (const [name, config] of entries) {
      yield* saveServer(fs, configService, name, config, trusted || config.trusted === true);
      yield* terminal.success(`Added MCP server: ${name}`);
    }

    yield* terminal.info(`Verify it works with: jazz mcp test ${entries[0]?.[0] ?? "<name>"}`);
  });
}

/**
 * Read all data from stdin (for piped input)
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

/** Parse repeated `--env KEY=VALUE` flags. */
function parseEnvPairs(pairs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return env;
}

export interface AddMcpServerOptions {
  readonly file?: string;
  readonly transport?: string;
  readonly env?: readonly string[];
  readonly header?: readonly string[];
  readonly trusted?: boolean;
}

/**
 * Add an MCP server.
 *
 * Four input paths, in the order they are tried: a name plus command (or URL)
 * as plain arguments, a JSON blob (inline, `--file`, or piped), and finally an
 * $EDITOR session. The shorthand exists because writing JSON by hand to add one
 * stdio server was the single most common thing people had to do here.
 *
 *   jazz mcp add linear --transport http https://mcp.linear.app/mcp
 *   jazz mcp add fs npx -y @modelcontextprotocol/server-filesystem ~/notes
 *   jazz mcp add '{"name": {"command": "..."}}'
 *   pbpaste | jazz mcp add
 */
export function addMcpServerCommand(
  nameOrJson?: string,
  commandArgs: readonly string[] = [],
  options: AddMcpServerOptions = {},
): Effect.Effect<void, never, McpCommandDeps> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const trusted = options.trusted === true;

    if (options.file) {
      const contentOpt = yield* fs.readFileString(options.file).pipe(Effect.option);
      if (Option.isNone(contentOpt)) {
        yield* terminal.error(`Could not read file: ${options.file}`);
        return;
      }
      return yield* parseAndSaveMcpServers(contentOpt.value, trusted);
    }

    // Shorthand: a bare name followed by a command or URL. A leading "{" means
    // the caller passed JSON instead.
    if (nameOrJson !== undefined && !nameOrJson.trimStart().startsWith("{")) {
      const name = nameOrJson;
      const isHttp = options.transport === "http" || options.transport === "sse";
      const [first, ...rest] = commandArgs;

      if (first === undefined) {
        yield* terminal.error(
          isHttp
            ? `Missing URL. Usage: jazz mcp add ${name} --transport http <url>`
            : `Missing command. Usage: jazz mcp add ${name} <command> [args...]`,
        );
        return;
      }

      const config: Record<string, unknown> = isHttp
        ? {
            transport: "http",
            url: first,
            ...(options.header && options.header.length > 0
              ? { headers: parseEnvPairs(options.header) }
              : {}),
          }
        : {
            command: first,
            ...(rest.length > 0 ? { args: rest } : {}),
            ...(options.env && options.env.length > 0 ? { env: parseEnvPairs(options.env) } : {}),
          };

      yield* saveServer(fs, configService, name, config, trusted);
      yield* terminal.success(`Added MCP server: ${name}`);
      if (!trusted) {
        yield* terminal.info(
          "Its tools will ask for approval on every call. Use `jazz mcp trust " +
            `${name}\` once you have reviewed them.`,
        );
      }
      yield* terminal.info(`Verify it works with: jazz mcp test ${name}`);
      return;
    }

    if (nameOrJson) {
      return yield* parseAndSaveMcpServers(nameOrJson, trusted);
    }

    if (!process.stdin.isTTY) {
      const stdinContent = yield* Effect.tryPromise({
        try: () => readStdin(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
      if (stdinContent.trim() === "") {
        yield* terminal.warn("No input received from stdin.");
        return;
      }
      return yield* parseAndSaveMcpServers(stdinContent, trusted);
    }

    const editor = process.env["EDITOR"] || process.env["VISUAL"] || "vi";
    const tmpFile = path.join(os.tmpdir(), `jazz-mcp-${Date.now()}.json`);

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

    return yield* parseAndSaveMcpServers(content, trusted);
  });
}

/** Describe a server's transport in one line. */
function describeTransport(config: MCPServerConfig): string {
  if (isHttpConfig(config)) return `http: ${config.url}`;
  return `stdio: ${config.command}${config.args?.length ? ` ${config.args.join(" ")}` : ""}`;
}

/**
 * List all configured MCP servers.
 *
 * With `--tools`, connects to each enabled server to report what it actually
 * advertises — the question "what did adding this server get me?" previously
 * had no answer short of starting a chat.
 */
export function listMcpServersCommand(
  options: { readonly tools?: boolean } = {},
): Effect.Effect<void, never, McpLiveDeps> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const entries = Object.entries(mcpServers);

    if (entries.length === 0) {
      yield* terminal.info("No MCP servers configured.");
      yield* terminal.log(fmt.keyValueCompact("Config", "~/.agents/mcp.json"));
      return;
    }

    yield* terminal.heading("MCP Servers");

    for (const [name, config] of entries) {
      const enabled = config.enabled !== false;
      const labels = [enabled ? "enabled" : "disabled"];
      if (config.trusted === true) labels.push("trusted");

      yield* terminal.log(
        fmt.itemWithDesc(name, `${describeTransport(config)} [${labels.join(", ")}]`),
      );

      if (options.tools === true && enabled) {
        const manager = yield* MCPServerManagerTag;
        const discovered = yield* manager.discoverTools({ ...config, name }).pipe(Effect.either);

        if (discovered._tag === "Right") {
          const toolNames = discovered.right.map((tool) => tool.name);
          yield* terminal.log(
            fmt.keyValue(
              "Tools",
              toolNames.length === 0
                ? "none advertised"
                : `${toolNames.length} — ${toolNames.join(", ")}`,
            ),
          );
        } else {
          yield* terminal.log(fmt.keyValue("Tools", `unavailable (${discovered.left.reason})`));
        }
      }
    }

    yield* terminal.log(fmt.footer(`Total: ${entries.length} server(s)`));
  });
}

/**
 * Connect to one server and report what it supports.
 *
 * The only way to check a server works without starting a conversation that
 * already has its tools selected.
 */
export function testMcpServerCommand(name: string): Effect.Effect<void, never, McpLiveDeps> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const manager = yield* MCPServerManagerTag;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const config = mcpServers[name];

    if (!config) {
      yield* terminal.error(`No MCP server named "${name}".`);
      yield* terminal.info("Run `jazz mcp list` to see configured servers.");
      return;
    }

    const serverConfig: MCPServerConfig = { ...config, name };

    yield* terminal.info(`Connecting to ${name} (${describeTransport(serverConfig)})...`);

    const connected = yield* manager.connectServer(serverConfig).pipe(Effect.either);

    if (connected._tag === "Left") {
      yield* terminal.error(connected.left.reason);
      if (connected.left.suggestion) {
        yield* terminal.info(connected.left.suggestion);
      }
      return;
    }

    const capabilities = yield* manager.getCapabilities(name);
    const protocolEra = yield* manager.getProtocolEra(name);
    const tools = yield* manager.getServerTools(name).pipe(Effect.either);
    const prompts = yield* manager.getServerPrompts(name).pipe(Effect.either);

    yield* terminal.success(`Connected to ${name}`);
    yield* terminal.log(
      fmt.keyValue(
        "Protocol",
        protocolEra === "modern"
          ? "2026-07-28 (modern)"
          : protocolEra === "legacy"
            ? "2025-era handshake (legacy)"
            : "unknown",
      ),
    );

    if (tools._tag === "Right") {
      yield* terminal.log(fmt.keyValue("Tools", String(tools.right.length)));
      for (const tool of tools.right) {
        const hints: string[] = [];
        if (tool.annotations?.readOnlyHint === true) hints.push("read-only");
        if (tool.annotations?.destructiveHint === true) hints.push("destructive");
        yield* terminal.log(
          fmt.itemWithDesc(
            tool.name,
            `${tool.description ?? "no description"}${hints.length > 0 ? ` (${hints.join(", ")})` : ""}`,
          ),
        );
      }
    } else {
      yield* terminal.warn(`Tools unavailable: ${tools.left.reason}`);
    }

    if (prompts._tag === "Right" && prompts.right.length > 0) {
      yield* terminal.log(fmt.keyValue("Prompts", String(prompts.right.length)));
      for (const prompt of prompts.right) {
        yield* terminal.log(
          fmt.itemWithDesc(`/${name}:${prompt.name}`, prompt.description ?? "no description"),
        );
      }
    }

    if (capabilities?.resources !== undefined) {
      const resources = yield* manager.getServerResources(name).pipe(Effect.either);
      if (resources._tag === "Right") {
        yield* terminal.log(fmt.keyValue("Resources", String(resources.right.length)));
        for (const resource of resources.right.slice(0, RESOURCE_PREVIEW_LIMIT)) {
          yield* terminal.log(
            fmt.itemWithDesc(resource.uri, resource.name ?? resource.description ?? ""),
          );
        }
        if (resources.right.length > RESOURCE_PREVIEW_LIMIT) {
          yield* terminal.log(
            fmt.item(`… ${resources.right.length - RESOURCE_PREVIEW_LIMIT} more`),
          );
        }
      } else {
        yield* terminal.warn(`Resources unavailable: ${resources.left.reason}`);
      }
    }

    if (config.trusted !== true) {
      yield* terminal.info(
        `Untrusted: every tool call will ask for approval. Run \`jazz mcp trust ${name}\` to let read-only annotations through.`,
      );
    }

    yield* manager.disconnectServer(name).pipe(Effect.catchAll(() => Effect.void));
  });
}

/**
 * Resolve a server name from an argument, falling back to an interactive
 * picker. Returns undefined when the user cancels or nothing matches.
 */
function resolveServerName(
  provided: string | undefined,
  candidates: readonly string[],
  prompt: string,
): Effect.Effect<string | undefined, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    if (provided !== undefined) {
      if (!candidates.includes(provided)) {
        yield* terminal.error(`No matching MCP server named "${provided}".`);
        return undefined;
      }
      return provided;
    }

    const selected = yield* terminal.select<string>(prompt, {
      choices: candidates.map((name) => ({ name, value: name })),
    });

    if (!selected) {
      yield* terminal.info("Cancelled.");
      return undefined;
    }

    return selected;
  });
}

/**
 * Remove an MCP server.
 *
 * Removes the server from ~/.agents/mcp.json and cleans up its Jazz-side
 * metadata. A server defined outside the user file cannot be deleted, so it is
 * marked disabled instead.
 */
export function removeMcpServerCommand(
  name?: string,
  options: { readonly yes?: boolean } = {},
): Effect.Effect<void, never, McpCommandDeps> {
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

    const selected = yield* resolveServerName(name, names, "Select a server to remove:");
    if (selected === undefined) return;

    if (options.yes !== true) {
      const confirmed = yield* terminal.confirm(`Remove server "${selected}"?`, false);
      if (!confirmed) {
        yield* terminal.info("Cancelled.");
        return;
      }
    }

    yield* removeAgentsMcpServer(fs, selected);
    // Touch only this server's key rather than rewriting the whole override
    // map, so a concurrent edit to another server is not clobbered.
    yield* configService.set(`mcpServers.${selected}`, { enabled: false });
    yield* clearServerAuth(selected);

    yield* terminal.success(`Removed MCP server: ${selected}`);
  });
}

/** Flip a server's `enabled` flag. */
function setServerEnabled(
  name: string | undefined,
  enabled: boolean,
): Effect.Effect<void, never, McpCommandDeps> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const candidates = Object.entries(mcpServers)
      .filter(([, config]) => (config.enabled !== false) !== enabled)
      .map(([serverName]) => serverName);

    if (candidates.length === 0) {
      yield* terminal.info(
        `No ${enabled ? "disabled" : "enabled"} MCP servers to ${enabled ? "enable" : "disable"}.`,
      );
      return;
    }

    const selected = yield* resolveServerName(
      name,
      candidates,
      `Select a server to ${enabled ? "enable" : "disable"}:`,
    );
    if (selected === undefined) return;

    yield* configService.set(`mcpServers.${selected}`, { enabled });
    yield* terminal.success(`${enabled ? "Enabled" : "Disabled"} MCP server: ${selected}`);
  });
}

export function enableMcpServerCommand(name?: string): Effect.Effect<void, never, McpCommandDeps> {
  return setServerEnabled(name, true);
}

export function disableMcpServerCommand(name?: string): Effect.Effect<void, never, McpCommandDeps> {
  return setServerEnabled(name, false);
}

/**
 * Mark whether the user vouches for a server.
 *
 * Trust is what lets a server's own `readOnlyHint` skip the approval prompt, so
 * it is a deliberate per-server decision rather than a global setting.
 */
export function trustMcpServerCommand(
  name: string | undefined,
  trusted: boolean,
): Effect.Effect<void, never, McpCommandDeps> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const names = Object.keys(mcpServers);

    if (names.length === 0) {
      yield* terminal.info("No MCP servers configured.");
      return;
    }

    const selected = yield* resolveServerName(
      name,
      names,
      `Select a server to ${trusted ? "trust" : "untrust"}:`,
    );
    if (selected === undefined) return;

    if (trusted) {
      yield* terminal.warn(
        `Trusting "${selected}" lets its tools declare themselves read-only and skip approval prompts.`,
      );
      const confirmed = yield* terminal.confirm(`Trust "${selected}"?`, false);
      if (!confirmed) {
        yield* terminal.info("Cancelled.");
        return;
      }
    }

    yield* configService.set(`mcpServers.${selected}`, { trusted });
    yield* terminal.success(`${trusted ? "Trusted" : "Untrusted"} MCP server: ${selected}`);
  });
}

/**
 * Run the OAuth authorization flow for a remote server.
 *
 * Kept out of the connect path on purpose: connecting happens inside agent runs
 * and unattended bridges, where opening a browser would be the wrong thing to
 * do. Those surfaces fail with a pointer to this command instead.
 */
export function authMcpServerCommand(name: string): Effect.Effect<void, never, McpCommandDeps> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    const mcpServers = yield* configService.getOrElse<McpServersRecord>("mcpServers", {});
    const config = mcpServers[name];

    if (!config) {
      yield* terminal.error(`No MCP server named "${name}".`);
      return;
    }

    const serverConfig: MCPServerConfig = { ...config, name };

    if (!isHttpConfig(serverConfig)) {
      yield* terminal.error(
        `"${name}" uses stdio transport, which does not use OAuth. Configure its credentials with env vars instead.`,
      );
      return;
    }

    if (serverConfig.headers) {
      yield* terminal.warn(
        `"${name}" has static headers configured, which take precedence over OAuth. Remove them to use the browser flow.`,
      );
      return;
    }

    yield* terminal.info(`Starting authorization for ${name}...`);

    const result = yield* authorizeServer(name, serverConfig.url, (url) => {
      process.stdout.write(`\nIf your browser did not open, visit:\n${url}\n\n`);
    }).pipe(Effect.either);

    if (result._tag === "Left") {
      yield* terminal.error(`Authorization failed: ${result.left.message}`);
      return;
    }

    yield* terminal.success(`Authorized ${name}. Tokens stored in your system keyring.`);
    yield* terminal.info(`Verify with: jazz mcp test ${name}`);
  });
}

/** Forget stored OAuth tokens for a server. */
export function logoutMcpServerCommand(name: string): Effect.Effect<void, never, McpCommandDeps> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    const stored = yield* hasStoredAuth(name);
    if (!stored) {
      yield* terminal.info(`No stored credentials for "${name}".`);
      return;
    }

    yield* clearServerAuth(name);
    yield* terminal.success(`Cleared stored credentials for ${name}.`);
  });
}
