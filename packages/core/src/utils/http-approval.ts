/**
 * Global approval policy for http_request and web_fetch. Unset means unrestricted automatic
 * requests; a configured URL list asks for every request outside it. Exact entries include the
 * query. A trailing /* grants descendants of that path on the same origin, including queries.
 * Matching uses the WHATWG URL parser, never a regex or hostname substring. One-call grants do
 * not modify configuration and redirect hops must independently match a grant.
 */
import type { HttpApprovalPolicy } from "@/core/types/config";

export const MAX_HTTP_URL_PATTERNS = 64;

/** Shared explanation for prompt and parked HTTP approvals. */
export const HTTP_APPROVAL_MESSAGE =
  "This URL is outside network.httpApproval. Approve this request once or edit your config file to grant it permanently.";

/** Whether this tool participates in HTTP approval rather than generic egress approval. */
export function isHttpApprovalTool(name: string): boolean {
  return name === "http_request" || name === "web_fetch";
}

function parsedHttpUrl(input: string): URL | undefined {
  try {
    const url = new URL(input);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return undefined;
    }
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

/** Validate an operator-supplied URL pattern at the configuration boundary. */
export function describeHttpUrlPatternError(input: string): string | undefined {
  const prefix = input.endsWith("/*");
  const base = prefix ? input.slice(0, -1) : input;
  const url = parsedHttpUrl(base);
  if (input.trim() !== input || url === undefined || input.includes("#") || base.includes("*")) {
    return "Enter an HTTP(S) URL without credentials or fragments; only a trailing /* wildcard is supported.";
  }
  return prefix && url.search !== ""
    ? "A trailing /* URL prefix cannot include a query string."
    : undefined;
}

/** The URL actually sent by a built-in request, including http_request query overrides. */
export function effectiveHttpUrl(name: string, args: Record<string, unknown>): string | undefined {
  if (!isHttpApprovalTool(name) || typeof args["url"] !== "string") return undefined;
  const url = parsedHttpUrl(args["url"]);
  if (url === undefined) return undefined;
  const query = args["query"];
  if (
    name === "http_request" &&
    query !== null &&
    typeof query === "object" &&
    !Array.isArray(query)
  ) {
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return undefined;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Whether a URL matches the global grant or an exact, one-call approval. */
export function httpUrlIsApproved(
  input: string,
  policy: HttpApprovalPolicy | undefined,
  approvedUrl?: string,
): boolean {
  const url = parsedHttpUrl(input);
  if (url === undefined) return false;
  if (policy === undefined || policy === "allow" || url.toString() === approvedUrl) return true;
  return policy.some((pattern) => {
    if (describeHttpUrlPatternError(pattern) !== undefined) return false;
    const prefix = pattern.endsWith("/*");
    const base = parsedHttpUrl(prefix ? pattern.slice(0, -1) : pattern);
    return (
      base !== undefined &&
      (prefix
        ? url.origin === base.origin && url.pathname.startsWith(base.pathname)
        : url.toString() === base.toString())
    );
  });
}

/** Undefined for other tools; HTTP approval decisions override risk tiers and session grants. */
export function httpToolIsApproved(
  name: string,
  args: Record<string, unknown>,
  policy: HttpApprovalPolicy | undefined,
): boolean | undefined {
  if (!isHttpApprovalTool(name)) return undefined;
  const url = effectiveHttpUrl(name, args);
  // Malformed URLs cannot perform network I/O; let the tool report its validation error.
  return url === undefined || httpUrlIsApproved(url, policy);
}
