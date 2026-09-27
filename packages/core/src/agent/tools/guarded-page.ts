/**
 * The destination policy for a headless browser page rendering HTML the model wrote.
 *
 * `create_pdf` and `create_composition` load a local HTML file in Chrome. The model wrote that
 * HTML, so every `<img>`, `<iframe>`, stylesheet and `fetch()` in it is a model-directed request
 * whose response can end up in the rendered PDF or screenshot. `guardPageRequests` holds those
 * requests to the same rules as `guardedFetch`: http(s) must pass `checkEgressDestination`,
 * `file:` URLs must stay inside the page's own directory, and `data:`, `blob:` and `about:`
 * (which never leave the page) load as usual.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HTTPRequest, Page } from "puppeteer-core";
import { secretPathReason } from "@/core/utils/secret-paths";
import { checkEgressDestination, type EgressPolicy } from "./guarded-fetch";

const IN_PAGE_PROTOCOLS: ReadonlySet<string> = new Set(["data:", "blob:", "about:"]);

function isInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Whether a `file:` request stays inside `pageDirectory` and off the secret-path list. */
function fileRequestAllowed(url: URL, pageDirectory: string): boolean {
  try {
    const requested = fileURLToPath(url);
    return isInsideDirectory(requested, pageDirectory) && secretPathReason(requested) === undefined;
  } catch {
    return false;
  }
}

async function decide(
  request: HTTPRequest,
  pageDirectory: string,
  policy: EgressPolicy,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return false;
  }
  if (IN_PAGE_PROTOCOLS.has(url.protocol)) {
    return true;
  }
  if (url.protocol === "file:") {
    return fileRequestAllowed(url, pageDirectory);
  }
  try {
    await checkEgressDestination(url, policy);
    return true;
  } catch {
    return false;
  }
}

/**
 * Intercept every request `page` makes and let through only what the policy allows.
 *
 * Call before `page.goto`. `htmlPath` is the file the page loads; its directory is the one
 * `file:` subresources may come from.
 */
export async function guardPageRequests(
  page: Page,
  htmlPath: string,
  policy: EgressPolicy,
): Promise<void> {
  const pageDirectory = path.dirname(path.resolve(htmlPath));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void decide(request, pageDirectory, policy).then(
      (allowed) =>
        (allowed ? request.continue() : request.abort("blockedbyclient")).catch(() => undefined),
      () => request.abort("blockedbyclient").catch(() => undefined),
    );
  });
}
