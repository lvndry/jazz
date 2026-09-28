/**
 * The destination policy for a headless browser page rendering HTML the model wrote.
 *
 * `create_pdf` and `create_composition` load a local HTML file in Chrome. The model wrote that
 * HTML, so every `<img>`, `<iframe>`, stylesheet and `fetch()` in it is a model-directed request
 * whose response can end up in the rendered PDF or screenshot. `guardPageRequests` holds those
 * requests to the same rules as `guardedFetch`: http(s) must pass `checkEgressDestination`,
 * `file:` URLs must stay inside the page's own directory, and `data:`, `blob:` and `about:`
 * (which never leave the page) load as usual.
 *
 * A `file:` text resource is served with its secret values redacted, the same redaction tool
 * output gets, so an `<iframe src=".env">` renders placeholders. Binary files (images, fonts)
 * load as they are.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HTTPRequest, Page } from "puppeteer-core";
import { redactSecretText, type KnownSecret } from "@/core/secrets/redaction";
import { checkEgressDestination, type EgressPolicy } from "./guarded-fetch";

const IN_PAGE_PROTOCOLS: ReadonlySet<string> = new Set(["data:", "blob:", "about:"]);

/** How much of a file is checked for NUL bytes to tell binary from text, as git does. */
const BINARY_SNIFF_BYTES = 8000;

const NUL_BYTE = 0;

const TEXT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".xhtml": "application/xhtml+xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".md": "text/markdown",
};

/** What to do with one request the page makes. */
export type PageRequestDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "abort" }
  | { readonly kind: "respond"; readonly contentType: string; readonly body: string };

function isInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The requested file's path when a `file:` request stays inside `pageDirectory`. */
function allowedFilePath(url: URL, pageDirectory: string): string | undefined {
  try {
    const requested = fileURLToPath(url);
    return isInsideDirectory(requested, pageDirectory) ? requested : undefined;
  } catch {
    return undefined;
  }
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(NUL_BYTE);
}

/** A text file's body with its secrets redacted, or `continue` for a binary file. */
async function fileDecision(
  filePath: string,
  known: readonly KnownSecret[],
): Promise<PageRequestDecision> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return { kind: "abort" };
  }
  if (isBinary(bytes)) {
    return { kind: "continue" };
  }
  const contentType = TEXT_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "text/plain";
  return {
    kind: "respond",
    contentType: `${contentType}; charset=utf-8`,
    body: redactSecretText(bytes.toString("utf8"), known),
  };
}

/** How the page's guard answers a request for `requestUrl`. */
export async function decidePageRequest(
  requestUrl: string,
  pageDirectory: string,
  policy: EgressPolicy,
  known: readonly KnownSecret[],
): Promise<PageRequestDecision> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: "abort" };
  }
  if (IN_PAGE_PROTOCOLS.has(url.protocol)) {
    return { kind: "continue" };
  }
  if (url.protocol === "file:") {
    const filePath = allowedFilePath(url, pageDirectory);
    return filePath === undefined ? { kind: "abort" } : fileDecision(filePath, known);
  }
  try {
    await checkEgressDestination(url, policy);
    return { kind: "continue" };
  } catch {
    return { kind: "abort" };
  }
}

function applyDecision(request: HTTPRequest, decision: PageRequestDecision): Promise<void> {
  switch (decision.kind) {
    case "continue":
      return request.continue();
    case "abort":
      return request.abort("blockedbyclient");
    case "respond":
      return request.respond({
        status: 200,
        contentType: decision.contentType,
        body: decision.body,
      });
  }
}

/**
 * Intercept every request `page` makes and let through only what the policy allows, serving
 * local text files redacted against `known`.
 *
 * Call before `page.goto`. `htmlPath` is the file the page loads; its directory is the one
 * `file:` subresources may come from.
 */
export async function guardPageRequests(
  page: Page,
  htmlPath: string,
  policy: EgressPolicy,
  known: readonly KnownSecret[],
): Promise<void> {
  const pageDirectory = path.dirname(path.resolve(htmlPath));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void decidePageRequest(request.url(), pageDirectory, policy, known).then(
      (decision) => applyDecision(request, decision).catch(() => undefined),
      () => request.abort("blockedbyclient").catch(() => undefined),
    );
  });
}
