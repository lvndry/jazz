import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createReadPdfTool } from "./read-pdf";
import { runTool } from "./test-helpers";

const tool = createReadPdfTool();
const testDir = join(tmpdir(), `jazz-read-pdf-test-${Date.now()}`);
const originalFetch = globalThis.fetch;

function stubFetch(fake: {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
}): void {
  globalThis.fetch = (async () =>
    ({
      ok: fake.ok,
      status: fake.status,
      statusText: fake.statusText,
      headers: fake.headers,
      arrayBuffer: async () => fake.body.buffer as ArrayBuffer,
    }) as unknown as Response) as unknown as typeof fetch;
}

const MEGABYTE = 1024 * 1024;

describe("read_pdf source selection", () => {
  it("rejects when neither path nor url is given", async () => {
    const result = await runTool(tool, {}, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("exactly one of path or url");
  });

  it("rejects when both path and url are given", async () => {
    const result = await runTool(
      tool,
      { path: "doc.pdf", url: "https://example.com/doc.pdf" },
      testDir,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("exactly one of path or url");
  });

  it("rejects a non-http url at validation", async () => {
    const result = await runTool(tool, { url: "ftp://example.com/doc.pdf" }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("http");
  });
});

describe("read_pdf local mode", () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "notes.txt"), "not a pdf");
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reports a missing file", async () => {
    const result = await runTool(tool, { path: join(testDir, "absent.pdf") }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path not found");
  });

  it("refuses a non-PDF extension", async () => {
    const result = await runTool(tool, { path: join(testDir, "notes.txt") }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a PDF");
  });
});

describe("read_pdf remote mode", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("surfaces an HTTP error status", async () => {
    stubFetch({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
      body: new Uint8Array(0),
    });
    const result = await runTool(tool, { url: "https://example.com/doc.pdf" }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });

  it("rejects an oversized download by content-length", async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": String(60 * MEGABYTE) }),
      body: new Uint8Array(0),
    });
    const result = await runTool(tool, { url: "https://example.com/big.pdf" }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
  });

  it("rejects a response whose body is not a PDF", async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html" }),
      body: new TextEncoder().encode("<html><body>not a pdf</body></html>"),
    });
    const result = await runTool(tool, { url: "https://example.com/page.html" }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("%PDF header");
  });

  it("passes a PDF-looking body through to the parser", async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/pdf" }),
      body: new TextEncoder().encode("%PDF-1.4 fake body"),
    });
    const result = await runTool(tool, { url: "https://example.com/doc.pdf" }, testDir);
    // The bytes clear the %PDF guard and reach pdf-parse; a fake PDF then fails in parsing,
    // which still proves the download path handed off correctly.
    expect(result.error ?? "").not.toContain("%PDF header");
  });
});
