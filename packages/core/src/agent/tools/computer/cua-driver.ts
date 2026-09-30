/**
 * `ComputerDriver` over a `cua-driver mcp` child process.
 *
 * The driver runs in standard permission mode: it is promptless, and Jazz's own grants, tiers
 * and approvals decide what reaches it. The environment the child gets has no manifest or mode
 * variables from the surrounding shell, so nothing outside Jazz can widen what the driver allows.
 * The child lives as long as the run's computer session and is stopped when it closes.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createSanitizedEnv } from "@/core/utils/env";
import { toError } from "@/core/utils/errors";
import {
  actionCall,
  type CuaToolCall,
  listAppsCall,
  listWindowsCall,
  parseActionResult,
  parseApps,
  parseWindows,
  parseWindowState,
  REQUIRED_CUA_TOOLS,
  structuredPayload,
  windowStateCall,
} from "./cua-contract";
import {
  type ComputerDriver,
  type DriverAction,
  type DriverActionResult,
  type DriverApp,
  DriverError,
  type DriverWindow,
  type DriverWindowState,
  type WindowStateOptions,
  type WindowTarget,
} from "./driver";

/** Longest the driver may take to start and answer `initialize`. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Longest one tool call may take, so a hung driver cannot stall the run. */
const CALL_TIMEOUT_MS = 60_000;

const CLIENT_NAME = "jazz-computer-use";

const CLIENT_VERSION = "1";

/** Environment variables that set the driver's permission mode, each forced to a known value. */
const DRIVER_MODE_ENVIRONMENT = {
  CUA_DRIVER_PERMISSION_MODE: "standard",
  CUA_DRIVER_CAPABILITY_MANIFEST_FILE: undefined,
  CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: undefined,
} as const;

export interface CuaDriverSettings {
  readonly executablePath: string;
  /** Arguments that start the MCP server; the driver's own command by default. */
  readonly args?: readonly string[];
}

export class CuaDriver implements ComputerDriver {
  private constructor(
    private readonly client: Client,
    readonly version: string | null,
    readonly pid: number | null,
  ) {}

  /** Start the driver and confirm it offers every tool computer use needs. */
  static async open(settings: CuaDriverSettings): Promise<CuaDriver> {
    const transport = new StdioClientTransport({
      command: settings.executablePath,
      args: [...(settings.args ?? ["mcp"])],
      env: createSanitizedEnv(DRIVER_MODE_ENVIRONMENT) as Record<string, string>,
    });
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const offered = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const missing = REQUIRED_CUA_TOOLS.filter((name) => !offered.has(name));
      if (missing.length > 0) {
        throw new DriverError(
          `The driver does not offer the tools computer use needs: ${missing.join(", ")}.`,
        );
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error instanceof DriverError
        ? error
        : new DriverError(`Could not start the computer-use driver: ${toError(error).message}`);
    }
    return new CuaDriver(client, client.getServerVersion()?.version ?? null, transport.pid);
  }

  private async call(toolCall: CuaToolCall): Promise<Record<string, unknown>> {
    try {
      const result = await this.client.callTool(
        { name: toolCall.name, arguments: { ...toolCall.arguments } },
        { timeout: CALL_TIMEOUT_MS },
      );
      return structuredPayload(result);
    } catch (error) {
      throw error instanceof DriverError ? error : new DriverError(toError(error).message);
    }
  }

  async listApps(): Promise<readonly DriverApp[]> {
    return parseApps(await this.call(listAppsCall()));
  }

  async listWindows(pid: number): Promise<readonly DriverWindow[]> {
    return parseWindows(await this.call(listWindowsCall(pid)));
  }

  async windowState(target: WindowTarget, options: WindowStateOptions): Promise<DriverWindowState> {
    return parseWindowState(await this.call(windowStateCall(target, options)));
  }

  async act(action: DriverAction): Promise<DriverActionResult> {
    return parseActionResult(await this.call(actionCall(action)));
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
