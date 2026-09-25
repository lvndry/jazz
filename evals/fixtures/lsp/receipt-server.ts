/**
 * Deterministic stdio language server for the ambient LSP coding eval. It reports a
 * real-looking unresolved import only while receipt.ts contains the bad symbol and
 * records document synchronization so the eval can detect a dormant plugin.
 */

import { appendFileSync } from "node:fs";

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

function requiredLogPath(): string {
  const path = process.argv[2];
  if (!path) throw new Error("receipt-server needs a synchronization log path");
  return path;
}

const logPath = requiredLogPath();

let buffered = Buffer.alloc(0);

function send(value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

function diagnose(uri: string, version: number, text: string): void {
  const badImport = 'import { formatPrice } from "./money";';
  const diagnostics = text.includes(badImport)
    ? [
        {
          source: "typescript",
          code: 2305,
          severity: 1,
          message:
            "Module './money' has no exported member 'formatPrice'. Did you mean 'formatCents'?",
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 20 },
          },
        },
      ]
    : [];
  appendFileSync(
    logPath,
    `${JSON.stringify({ uri, version, diagnosticCount: diagnostics.length })}\n`,
  );
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, version, diagnostics },
  });
}

function handle(message: Message): void {
  if (message.method === "textDocument/didOpen") {
    const document = message.params?.["textDocument"] as
      { uri?: string; version?: number; text?: string } | undefined;
    if (document?.uri && document.version !== undefined && document.text !== undefined)
      diagnose(document.uri, document.version, document.text);
  }
  if (message.method === "textDocument/didChange") {
    const document = message.params?.["textDocument"] as
      { uri?: string; version?: number } | undefined;
    const changes = message.params?.["contentChanges"] as readonly { text?: string }[] | undefined;
    const text = changes?.at(-1)?.text;
    if (document?.uri && document.version !== undefined && text !== undefined)
      diagnose(document.uri, document.version, text);
  }
  if (message.id === undefined) return;
  const result =
    message.method === "initialize"
      ? { capabilities: { textDocumentSync: 1, diagnosticProvider: false } }
      : null;
  send({ jsonrpc: "2.0", id: message.id, result });
}

process.stdin.on("data", (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (true) {
    const split = buffered.indexOf("\r\n\r\n");
    if (split < 0) return;
    const match = /^content-length:\s*(\d+)\s*$/im.exec(
      buffered.subarray(0, split).toString("ascii"),
    );
    if (!match) throw new Error("invalid LSP frame header");
    const length = Number(match[1]);
    if (buffered.byteLength < split + 4 + length) return;
    const message = JSON.parse(
      buffered.subarray(split + 4, split + 4 + length).toString("utf8"),
    ) as Message;
    buffered = buffered.subarray(split + 4 + length);
    handle(message);
  }
});
