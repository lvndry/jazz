/**
 * The destination policy for every request a browser page makes.
 *
 * A page is the model's HTTP client with its own scripts: each navigation, image, stylesheet,
 * `fetch()` and redirect it issues is held to the rules `guardedFetch` applies to one request.
 *
 * - `http:` and `https:` must pass `checkEgressDestination`: public addresses only, unless
 *   `network.allowPrivateHosts` or an approval for this call names the host.
 * - When `network.httpApproval` is a URL list, a document navigation must match a grant. Other
 *   requests must match a grant too, or go to an origin the run already navigated to with
 *   approval, so a page cannot send data to a third origin the operator never allowed.
 * - `file:`, `chrome:` and every other scheme are refused. `data:`, `blob:` and `about:` load
 *   inside the page and never leave it, except as a top-level navigation target, where only
 *   `about:blank` is accepted.
 *
 * WebSocket and WebRTC traffic does not pass through request interception, so this policy does
 * not cover it.
 */

import { httpUrlIsApproved } from "@/core/utils/http-approval";
import { checkEgressDestination, type EgressPolicy } from "../guarded-fetch";

export type BrowserRequestDecision =
  { readonly kind: "continue" } | { readonly kind: "abort"; readonly reason: string };

export interface BrowserRequest {
  readonly url: string;
  /** A navigation of the page's main frame, as opposed to a subresource or a frame's own load. */
  readonly isMainFrameNavigation: boolean;
}

const IN_PAGE_PROTOCOLS: ReadonlySet<string> = new Set(["data:", "blob:", "about:"]);

const BLANK_PAGE = "about:blank";

const CONTINUE: BrowserRequestDecision = { kind: "continue" };

function abort(reason: string): BrowserRequestDecision {
  return { kind: "abort", reason };
}

/**
 * How the guard answers `request`.
 *
 * `approvedOrigins` holds the origins of navigations this run made with approval; the caller
 * adds to it after a navigation that cleared the grant list. `verifiedHosts` holds hostnames
 * whose addresses already passed the destination check under this policy, so a page that loads
 * a hundred subresources from one host resolves it once; the guard adds to it.
 */
export async function decideBrowserRequest(
  request: BrowserRequest,
  policy: EgressPolicy,
  approvedOrigins: ReadonlySet<string>,
  verifiedHosts: Set<string> = new Set(),
): Promise<BrowserRequestDecision> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return abort("malformed URL");
  }

  if (
    request.isMainFrameNavigation &&
    request.url !== BLANK_PAGE &&
    IN_PAGE_PROTOCOLS.has(url.protocol)
  ) {
    return abort(`navigation to ${url.protocol} URLs is not supported`);
  }
  if (IN_PAGE_PROTOCOLS.has(url.protocol)) {
    return CONTINUE;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return abort(`${url.protocol} URLs are not supported`);
  }

  const grants = policy.httpApproval;
  if (grants !== undefined && grants !== "allow") {
    const granted = httpUrlIsApproved(request.url, grants, policy.approvedHttpUrl);
    const sameApprovedOrigin = !request.isMainFrameNavigation && approvedOrigins.has(url.origin);
    if (!granted && !sameApprovedOrigin) {
      return abort("outside network.httpApproval");
    }
  }

  if (verifiedHosts.has(url.hostname)) {
    return CONTINUE;
  }
  try {
    await checkEgressDestination(url, policy);
  } catch (error) {
    return abort(error instanceof Error ? error.message : "destination refused");
  }
  verifiedHosts.add(url.hostname);
  return CONTINUE;
}
