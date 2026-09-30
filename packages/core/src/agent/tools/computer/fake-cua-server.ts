/**
 * A stand-in for `cua-driver mcp`, for tests of the adapter: it speaks just enough MCP over
 * stdio (newline-delimited JSON-RPC) to be started, list its tools, and answer a few calls.
 *
 * Environment:
 * - `FAKE_CUA_OMIT_TOOL` names a tool to leave out of `tools/list`.
 * - `FAKE_CUA_ECHO_ENV` makes `list_apps` report the permission-mode environment it was started
 *   with, so a test can check what the adapter passed down.
 */

import { createInterface } from "node:readline";

const TOOL_NAMES = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "click",
  "type_text",
  "press_key",
  "scroll",
];

const omitted = process.env["FAKE_CUA_OMIT_TOOL"];

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(payload: unknown, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: isError ? undefined : payload,
    isError,
  };
}

function handleCall(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "list_apps":
      return toolResult({
        apps: [
          {
            pid: 500,
            name:
              process.env["FAKE_CUA_ECHO_ENV"] === undefined
                ? "Notes"
                : `mode=${process.env["CUA_DRIVER_PERMISSION_MODE"] ?? "unset"};manifest=${process.env["CUA_DRIVER_CAPABILITY_MANIFEST_FILE"] ?? "unset"}`,
            bundle_id: "com.apple.Notes",
            running: true,
            active: false,
          },
        ],
      });
    case "list_windows":
      return toolResult({
        windows: [
          {
            window_id: 7,
            pid: args["pid"],
            app_name: "Notes",
            title: "Note",
            bounds: { x: 0, y: 0, width: 400, height: 300 },
            is_on_screen: true,
            z_index: 0,
          },
        ],
      });
    case "get_window_state":
      return toolResult({
        pid: args["pid"],
        window_id: args["window_id"],
        app_name: "Notes",
        window_title: "Note",
        snapshot_id: "s1",
        elements: [
          { element_index: 0, role: "AXButton", depth: 0, element_token: "t0", label: "New" },
        ],
        elements_complete: true,
        window_bounds: { x: 0, y: 0, width: 400, height: 300 },
      });
    case "click":
      return toolResult({ effect: "confirmed", route: "accessibility", summary: "clicked" });
    default:
      return toolResult({ error: { code: "unknown_tool", hint: name } }, true);
  }
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }
  const request = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  if (request.id === undefined) {
    return;
  }
  switch (request.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-cua-driver", version: "0.0.1" },
        },
      });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: TOOL_NAMES.filter((name) => name !== omitted).map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        },
      });
      break;
    case "tools/call":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: handleCall(request.params?.name ?? "", request.params?.arguments ?? {}),
      });
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
