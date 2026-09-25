/**
 * Generic LSP client operations and lazy server pool. Every request synchronizes
 * the file's current disk contents before asking the configured language server.
 * The pool is keyed by server command and workspace root, and idle children exit.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  workspaceServers,
  type ServerConfig,
  type SelectedServer,
  type WorkspaceServer,
} from "./config";
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
const failedStarts = new Map<string, { readonly at: number; readonly error: unknown }>();
const IDLE_MS = 120_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const DIAGNOSTIC_WAIT_MS = 1_500;
const AMBIENT_DIAGNOSTIC_WAIT_MS = 2_500;
const AMBIENT_PULL_TIMEOUT_MS = 1_000;
const DEFAULT_FORMAT_TAB_SIZE = 2;
const FAILED_SERVER_RETRY_MS = 30_000;

type TextDocumentSyncKind = 0 | 1 | 2;

function documentSync(capabilities: Record<string, unknown>): {
  readonly openClose: boolean;
  readonly change: TextDocumentSyncKind;
} {
  const sync = capabilities["textDocumentSync"];
  if (typeof sync === "number")
    return { openClose: sync !== 0, change: sync === 1 || sync === 2 ? sync : 0 };
  if (sync === null || typeof sync !== "object") return { openClose: false, change: 0 };
  const options = sync as { openClose?: unknown; change?: unknown };
  return {
    openClose: options.openClose === true,
    change: options.change === 1 || options.change === 2 ? options.change : 0,
  };
}

function fullDocumentRange(text: string): { start: Position; end: Position } {
  const lines = text.split("\n");
  return {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 },
  };
}

function key(config: ServerConfig, root: string): string {
  return JSON.stringify([config.command, config.args, root]);
}

async function start(selected: WorkspaceServer, signal: AbortSignal): Promise<RunningServer> {
  const { config, root } = selected;
  const transport = new LspTransport(config.command, config.args, root);
  try {
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
      INITIALIZE_TIMEOUT_MS,
    )) as { capabilities?: Record<string, unknown> };
    transport.notify("initialized", {});
    return { transport, documents: new Map(), capabilities: response.capabilities ?? {} };
  } catch (error) {
    transport.terminate();
    throw error;
  }
}

async function runningServer(
  selected: WorkspaceServer,
  signal: AbortSignal,
): Promise<RunningServer> {
  const id = key(selected.config, selected.root);
  let promise = servers.get(id);
  if (!promise) {
    const failed = failedStarts.get(id);
    if (failed && Date.now() - failed.at < FAILED_SERVER_RETRY_MS) throw failed.error;
    failedStarts.delete(id);
    promise = start(selected, signal);
    servers.set(id, promise);
    void promise.then(
      () => failedStarts.delete(id),
      (error: unknown) => {
        if (servers.get(id) === promise) servers.delete(id);
        if (!signal.aborted) failedStarts.set(id, { at: Date.now(), error });
      },
    );
  }
  const server = await promise;
  if (server.transport.isClosed) {
    servers.delete(id);
    return runningServer(selected, signal);
  }
  if (server.timer) clearTimeout(server.timer);
  server.timer = setTimeout(() => {
    void server.transport.close();
    servers.delete(id);
  }, IDLE_MS);
  server.timer.unref();
  return server;
}

/** Initialize configured workspace servers independently and report failed starts. */
export async function activateWorkspace(
  cwd: string,
  signal: AbortSignal,
): Promise<readonly unknown[]> {
  const selected = await workspaceServers(cwd);
  const results = await Promise.allSettled(
    [...new Map(selected.map((server) => [key(server.config, server.root), server])).values()].map(
      (server) => runningServer(server, signal),
    ),
  );
  return results.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
}

/** Get a live server and synchronize the named document from disk. */
export async function document(
  selected: SelectedServer,
  signal: AbortSignal,
): Promise<{ server: RunningServer; uri: string; text: string; changed: boolean }> {
  const server = await runningServer(selected, signal);
  const uri = pathToFileURL(selected.path).href;
  const text = await readFile(selected.path, "utf8");
  const previous = server.documents.get(uri);
  const changed = previous?.text !== text;
  const sync = documentSync(server.capabilities);
  if (!previous) {
    server.documents.set(uri, { text, version: 1 });
    server.transport.setDocumentVersion(uri, 1);
    if (sync.openClose)
      server.transport.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: selected.config.languageId, version: 1, text },
      });
  } else if (previous.text !== text) {
    const version = previous.version + 1;
    server.documents.set(uri, { text, version });
    server.transport.setDocumentVersion(uri, version);
    if (sync.change === 1) {
      server.transport.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    } else if (sync.change === 2) {
      server.transport.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ range: fullDocumentRange(previous.text), text }],
      });
    } else if (sync.openClose) {
      server.transport.notify("textDocument/didClose", { textDocument: { uri } });
      server.transport.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: selected.config.languageId, version, text },
      });
    }
  }
  return { server, uri, text, changed };
}

/** Synchronize a touched file and collect diagnostics without a model tool call. */
export async function ambientDiagnostics(
  selected: SelectedServer,
  signal: AbortSignal,
): Promise<unknown[]> {
  const { server, uri, changed } = await document(selected, signal);
  if (server.capabilities["diagnosticProvider"]) {
    const response = await server.transport.request(
      "textDocument/diagnostic",
      { textDocument: { uri } },
      signal,
      AMBIENT_PULL_TIMEOUT_MS,
    );
    return response !== null &&
      typeof response === "object" &&
      "items" in response &&
      Array.isArray(response.items)
      ? (response.items as unknown[])
      : [];
  }
  if (!changed) return server.transport.currentDiagnostics(uri) ?? [];
  return server.transport.waitForNonemptyDiagnostics(uri, signal, AMBIENT_DIAGNOSTIC_WAIT_MS);
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
    return server.transport.waitForDiagnostics(uri, signal, DIAGNOSTIC_WAIT_MS);
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
      tabSize: args["tabSize"] ?? DEFAULT_FORMAT_TAB_SIZE,
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
