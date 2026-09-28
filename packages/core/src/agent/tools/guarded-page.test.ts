import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { HTTPRequest, Page } from "puppeteer-core";
import { decidePageRequest, guardPageRequests } from "./guarded-page";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe("guarded page file requests", () => {
  const root = mkdtempSync(join(tmpdir(), "jazz-guarded-page-"));
  const pageDirectory = join(root, "page");
  const known = [{ name: "llm.test.api_key", value: "k9-page-known-value-0123" }];

  beforeAll(() => {
    mkdirSync(pageDirectory);
    writeFileSync(join(pageDirectory, ".env"), "DB_PASSWORD=hunter2hunter2\nDEBUG=1\n");
    writeFileSync(join(pageDirectory, "notes.html"), "<p>key k9-page-known-value-0123</p>");
    writeFileSync(join(pageDirectory, "chart.png"), PNG_SIGNATURE);
    writeFileSync(join(root, "outside.txt"), "outside\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const decide = (file: string) =>
    decidePageRequest(pathToFileURL(file).href, pageDirectory, {}, known);

  it("serves a text file with its secret values redacted", async () => {
    expect(await decide(join(pageDirectory, ".env"))).toEqual({
      kind: "respond",
      contentType: "text/plain; charset=utf-8",
      body: "DB_PASSWORD=[redacted:DB_PASSWORD]\nDEBUG=1\n",
    });
    expect(await decide(join(pageDirectory, "notes.html"))).toMatchObject({
      kind: "respond",
      contentType: "text/html; charset=utf-8",
      body: "<p>key [redacted:llm.test.api_key]</p>",
    });
  });

  it("loads a binary file as it is and refuses files outside the page's directory", async () => {
    expect(await decide(join(pageDirectory, "chart.png"))).toEqual({ kind: "continue" });
    expect(await decide(join(root, "outside.txt"))).toEqual({ kind: "abort" });
    expect(await decide(join(pageDirectory, "missing.txt"))).toEqual({ kind: "abort" });
  });

  it("answers an intercepted request with the redacted body", async () => {
    let listener: ((request: HTTPRequest) => void) | undefined;
    const page = {
      setRequestInterception: () => Promise.resolve(),
      on: (_event: string, handler: (request: HTTPRequest) => void) => {
        listener = handler;
      },
    } as unknown as Page;
    await guardPageRequests(page, join(pageDirectory, "index.html"), {}, known);

    const responded = new Promise<unknown>((resolve) => {
      const request = {
        url: () => pathToFileURL(join(pageDirectory, ".env")).href,
        continue: () => Promise.resolve(resolve("continue")),
        abort: () => Promise.resolve(resolve("abort")),
        respond: (response: unknown) => Promise.resolve(resolve(response)),
      } as unknown as HTTPRequest;
      listener?.(request);
    });

    expect(await responded).toMatchObject({
      status: 200,
      body: "DB_PASSWORD=[redacted:DB_PASSWORD]\nDEBUG=1\n",
    });
  });
});
