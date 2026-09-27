/**
 * Framed JSON-RPC 2.0 transport for a locally configured LSP server. It owns the
 * child process, correlates requests, handles cancellation and server requests,
 * and publishes diagnostics. No model input ever becomes a process command.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

type Response = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};
type Notification = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
  readonly id?: number | string;
};

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_DIAGNOSTIC_WAIT_MS = 1_500;

interface DiagnosticState {
  readonly version?: number;
  readonly diagnostics: unknown[];
}

export class LspTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly diagnostics = new Map<string, DiagnosticState>();
  private readonly documentVersions = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly exited: Promise<void>;
  readonly root: string;

  constructor(command: string, args: readonly string[], root: string) {
    this.root = root;
    this.child = spawn(command, [...args], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", () => undefined);
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) =>
      this.fail(new Error(`language server exited (${code ?? "signal"})`)),
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  setDocumentVersion(uri: string, version: number): void {
    this.documentVersions.set(uri, version);
    this.diagnostics.delete(uri);
  }

  currentDiagnostics(uri: string): unknown[] | undefined {
    return this.diagnostics.get(uri)?.diagnostics;
  }

  private send(payload: unknown): void {
    if (this.closed) throw new Error("language server is closed");
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error(`${method} cancelled`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!this.closed) this.notify("$/cancelRequest", { id });
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (!this.closed) this.notify("$/cancelRequest", { id });
        reject(new Error(`${method} cancelled`));
      };
      const finish = (action: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        action();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.fail(new Error("LSP frame exceeds 16 MiB"));
      return;
    }
    while (true) {
      const split = this.buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      const header = this.buffer.subarray(0, split).toString("ascii");
      const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
      if (!match) {
        this.fail(new Error("invalid LSP frame"));
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
        this.fail(new Error("LSP frame exceeds 16 MiB"));
        return;
      }
      if (this.buffer.length < split + 4 + length) return;
      const body = this.buffer.subarray(split + 4, split + 4 + length);
      this.buffer = this.buffer.subarray(split + 4 + length);
      try {
        this.dispatch(JSON.parse(body.toString("utf8")) as Response | Notification);
      } catch {
        this.fail(new Error("invalid LSP JSON"));
        return;
      }
    }
  }

  private dispatch(message: Response | Notification): void {
    if ("method" in message) {
      if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as
          { uri?: unknown; version?: unknown; diagnostics?: unknown } | undefined;
        if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
          const version = params.version;
          const currentVersion = this.documentVersions.get(params.uri);
          const previousVersion = this.diagnostics.get(params.uri)?.version;
          if (
            typeof version === "number" &&
            (version < (currentVersion ?? 0) || version < (previousVersion ?? 0))
          )
            return;
          this.diagnostics.set(params.uri, {
            ...(typeof version === "number" ? { version } : {}),
            diagnostics: params.diagnostics,
          });
          for (const listener of this.listeners.get(params.uri) ?? []) listener();
        }
      }
      if (message.id !== undefined) {
        const result =
          message.method === "workspace/applyEdit"
            ? { applied: false, failureReason: "Jazz requires an approved plugin tool edit" }
            : message.method === "workspace/configuration"
              ? Array.isArray((message.params as { items?: unknown })?.items)
                ? (message.params as { items: unknown[] }).items.map(() => null)
                : []
              : message.method === "workspace/workspaceFolders"
                ? [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }]
                : null;
        this.send({ jsonrpc: "2.0", id: message.id, result });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(new Error(`LSP ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  async waitForDiagnostics(
    uri: string,
    signal: AbortSignal,
    waitMs = DEFAULT_DIAGNOSTIC_WAIT_MS,
  ): Promise<unknown[]> {
    return this.waitForDiagnosticsMatching(uri, signal, waitMs, () => true);
  }

  async waitForNonemptyDiagnostics(
    uri: string,
    signal: AbortSignal,
    waitMs: number,
  ): Promise<unknown[]> {
    return this.waitForDiagnosticsMatching(
      uri,
      signal,
      waitMs,
      (diagnostics) => diagnostics.length > 0,
    );
  }

  private async waitForDiagnosticsMatching(
    uri: string,
    signal: AbortSignal,
    waitMs: number,
    matches: (diagnostics: unknown[]) => boolean,
  ): Promise<unknown[]> {
    const current = this.diagnostics.get(uri);
    if (current && matches(current.diagnostics)) return current.diagnostics;
    if (signal.aborted) return current?.diagnostics ?? [];
    return new Promise((resolve) => {
      const finish = (force = false) => {
        const latest = this.diagnostics.get(uri)?.diagnostics ?? [];
        if (!force && !matches(latest)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.listeners.get(uri)?.delete(finish);
        resolve(latest);
      };
      const abort = () => finish(true);
      const timer = setTimeout(() => finish(true), waitMs);
      const listeners = this.listeners.get(uri) ?? new Set<() => void>();
      listeners.add(finish);
      this.listeners.set(uri, listeners);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child.kill();
  }

  terminate(): void {
    this.fail(new Error("language server terminated"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS);
      if (this.closed) return;
      this.notify("exit", null);
      this.child.stdin.end();
    } catch {
      this.terminate();
      return;
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), EXIT_TIMEOUT_MS);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) this.terminate();
  }
}
