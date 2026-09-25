/**
 * Generic LSP client operations and lazy server pool. Every request synchronizes
 * the file's current disk contents before asking the configured language server.
 * The pool is keyed by server command and workspace root, and idle children exit.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ServerConfig, SelectedServer } from "./config";
import { LspTransport } from "./transport";

interface DocumentState {
  readonly text: string;
  readonly version: number;
}
interface RunningServer {
  readonly transport: LspTransport;
  readonly documents: Map<string, DocumentState>;
  readonly capabilities: Record<string, unknown>;
  timer?: ReturnType<typeof setTimeout>;
}

const servers = new Map<string, Promise<RunningServer>>();
const IDLE_MS = 120_000;

function key(config: ServerConfig, root: string): string {
  return JSON.stringify([config.command, config.args, config.id, root]);
}

async function start(selected: SelectedServer, signal: AbortSignal): Promise<RunningServer> {
  const { config, root } = selected;
  const transport = new LspTransport(config.command, config.args, root);
  const response = (await transport.request(
    "initialize",
    {
      processId: process.pid,
      clientInfo: { name: "Jazz LSP plugin", version: "0.1.0" },
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: root.split("/").at(-1) }],
      capabilities: {
        workspace: {
          workspaceEdit: {
            documentChanges: true,
          },
          configuration: true,
          workspaceFolders: true,
        },
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          definition: { linkSupport: true },
          codeAction: { dataSupport: true },
        },
      },
    },
    signal,
    20_000,
  )) as { capabilities?: Record<string, unknown> };
  transport.notify("initialized", {});
  return { transport, documents: new Map(), capabilities: response.capabilities ?? {} };
}

/** Get a live server and synchronize the named document from disk. */
export async function document(
  selected: SelectedServer,
  signal: AbortSignal,
): Promise<{ server: RunningServer; uri: string; text: string }> {
  const id = key(selected.config, selected.root);
  let promise = servers.get(id);
  if (!promise) {
    promise = start(selected, signal);
    servers.set(id, promise);
    void promise.catch(() => servers.delete(id));
  }
  const server = await promise;
  if (server.transport.isClosed) {
    servers.delete(id);
    return document(selected, signal);
  }
  if (server.timer) clearTimeout(server.timer);
  server.timer = setTimeout(() => {
    server.transport.close();
    servers.delete(id);
  }, IDLE_MS);
  server.timer.unref();
  const uri = pathToFileURL(selected.path).href;
  const text = await readFile(selected.path, "utf8");
  const previous = server.documents.get(uri);
  if (!previous) {
    server.documents.set(uri, { text, version: 1 });
    server.transport.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: selected.config.languageId, version: 1, text },
    });
  } else if (previous.text !== text) {
    server.transport.clearDiagnostics(uri);
    server.transport.notify("textDocument/didClose", { textDocument: { uri } });
    const version = previous.version + 1;
    server.documents.set(uri, { text, version });
    server.transport.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: selected.config.languageId, version, text },
    });
  }
  return { server, uri, text };
}

export interface Position {
  readonly line: number;
  readonly character: number;
}

/** Convert user-facing 1-based coordinates to LSP 0-based UTF-16 positions. */
export function position(line: unknown, character: unknown): Position {
  if (
    !Number.isInteger(line) ||
    !Number.isInteger(character) ||
    (line as number) < 1 ||
    (character as number) < 1
  )
    throw new Error("line and character must be positive, 1-based integers");
  return { line: (line as number) - 1, character: (character as number) - 1 };
}

/** Request a read-only language feature and return its raw protocol value. */
export async function query(
  selected: SelectedServer,
  method: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const { server, uri } = await document(selected, signal);
  const textDocument = { uri };
  if (method === "textDocument/diagnostic") {
    if (server.capabilities["diagnosticProvider"]) {
      return server.transport.request(method, { textDocument }, signal);
    }
    return server.transport.waitForDiagnostics(uri, signal);
  }
  if (method === "workspace/symbol")
    return server.transport.request(method, { query: args["query"] }, signal);
  const params: Record<string, unknown> = { textDocument };
  if (args["line"] !== undefined) params["position"] = position(args["line"], args["character"]);
  if (method === "textDocument/references")
    params["context"] = { includeDeclaration: args["includeDeclaration"] !== false };
  if (method === "textDocument/codeAction") {
    const start = position(args["startLine"], args["startCharacter"]);
    const end = position(args["endLine"], args["endCharacter"]);
    params["range"] = { start, end };
    params["context"] = {
      diagnostics: await server.transport.waitForDiagnostics(uri, signal, 500),
    };
  }
  if (method === "textDocument/formatting") {
    params["options"] = {
      tabSize: args["tabSize"] ?? 2,
      insertSpaces: args["insertSpaces"] ?? true,
    };
  }
  if (method === "textDocument/rename") params["newName"] = args["newName"];
  return server.transport.request(method, params, signal);
}

/** Resolve a lazy code action when the server advertises that capability. */
export async function resolveCodeAction(
  selected: SelectedServer,
  action: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const { server } = await document(selected, signal);
  const provider = server.capabilities["codeActionProvider"];
  if (
    !provider ||
    typeof provider !== "object" ||
    !("resolveProvider" in provider) ||
    provider.resolveProvider !== true
  )
    return action;
  return server.transport.request("codeAction/resolve", action, signal);
}
