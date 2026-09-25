/**
 * Deterministic stdio LSP server for exercising the plugin's framing, semantic
 * requests, diagnostics, workspace edits, and denied server-initiated writes.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

let buffer = Buffer.alloc(0);
let uri = "";
function send(value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString());
    if (!match) throw new Error("bad frame");
    const size = Number(match[1]);
    if (buffer.length < split + 4 + size) return;
    const message = JSON.parse(buffer.subarray(split + 4, split + 4 + size).toString()) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    buffer = buffer.subarray(split + 4 + size);
    if (message.method === "textDocument/didOpen") {
      uri = (message.params?.["textDocument"] as { uri: string }).uri;
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          version: (message.params?.["textDocument"] as { version: number }).version,
          diagnostics: [
            {
              message: "fake warning",
              severity: 2,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
        },
      });
    }
    if (message.method === "textDocument/didChange") {
      const change = (
        message.params?.["contentChanges"] as {
          text: string;
          range?: unknown;
        }[]
      )[0];
      const text = change?.text ?? "";
      const missingIncrementalRange = process.argv[4] === "2" && change?.range === undefined;
      const version = (message.params?.["textDocument"] as { version: number }).version;
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          version,
          diagnostics: [
            {
              message: missingIncrementalRange
                ? "missing incremental range"
                : `changed warning: ${text.trim()}`,
              severity: 2,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
        },
      });
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          version: version - 1,
          diagnostics: [{ message: "stale warning" }],
        },
      });
    }
    if (message.id === undefined || !message.method) continue;
    if (message.method === "initialize" && process.argv[3])
      writeFileSync(process.argv[3], "started");
    const edit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "bar",
          },
        ],
      },
    };
    const result =
      message.method === "initialize"
        ? {
            capabilities: {
              textDocumentSync: Number(process.argv[4] ?? 1),
              renameProvider: true,
              codeActionProvider: { resolveProvider: true },
              documentFormattingProvider: true,
            },
          }
        : message.method === "textDocument/hover"
          ? { contents: "Fake symbol" }
          : message.method === "textDocument/rename"
            ? edit
            : message.method === "textDocument/codeAction"
              ? [
                  { title: "Fix foo", edit },
                  { title: "Lazy fix foo", data: { id: 1 } },
                ]
              : message.method === "codeAction/resolve"
                ? { title: "Lazy fix foo", edit }
                : message.method === "textDocument/formatting"
                  ? edit.changes[uri]
                  : message.method === "textDocument/definition"
                    ? [
                        {
                          uri: pathToFileURL(process.argv[2] ?? "").href,
                          range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 3 },
                          },
                        },
                      ]
                    : null;
    send({ jsonrpc: "2.0", id: message.id, result });
  }
});
