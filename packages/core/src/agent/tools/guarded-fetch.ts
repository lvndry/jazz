/**
 * The one `fetch` for URLs a model chose.
 *
 * `http_request`, `web_fetch`, `read_pdf` and the headless renderers all send requests to
 * addresses that came out of a model, which means out of whatever the model last read. This
 * module is the single place those requests go through, and it enforces four things plain
 * `fetch` does not:
 *
 * 1. **Public destinations only.** The hostname is resolved and every address it resolves to
 *    must be public (see `classifyAddress`), unless the agent's `network.allowPrivateHosts`
 *    lists the hostname or the address. Loopback, RFC 1918, link-local (including the cloud
 *    metadata service at 169.254.169.254), CGNAT, IPv4-mapped IPv6 and `0.0.0.0` are refused.
 * 2. **Every redirect hop is checked.** Redirects are followed by hand, up to
 *    `MAX_REDIRECT_HOPS`, and each `Location` passes the same destination check before it is
 *    requested.
 * 3. **Credentials stay with the origin they were written for.** On a cross-origin hop only
 *    the headers in `CROSS_ORIGIN_SAFE_HEADERS` are carried; `Authorization`, `Cookie` and any
 *    custom header the model supplied are dropped. A cross-origin 307/308 that would resend a
 *    request body is returned to the caller instead of followed.
 * 4. **Bodies are read against a byte budget.** `readBodyWithinBudget` streams the body and
 *    stops at the cap, so a response is never buffered whole before it is measured. Callers keep
 *    their abort timer running until the body read finishes.
 *
 * The check resolves DNS once per hop and the runtime resolves again when it connects, so a
 * hostname whose answer changes between the two (DNS rebinding with a zero TTL) is not stopped
 * by this module. IP-literal URLs and every redirect target are covered either way.
 */

import { promises as dnsPromises } from "node:dns";
import type { ToolExecutionContext } from "@/core/types";
import {
  classifyAddress,
  isIpLiteral,
  normalizeHostname,
  parsePrivateHostAllowlist,
  type PrivateHostAllowlist,
  unbracketHost,
} from "@/core/utils/private-network";

/** The Fetch Standard's redirect limit (https://fetch.spec.whatwg.org/#http-redirect-fetch). */
export const MAX_REDIRECT_HOPS = 20;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const BODY_PRESERVING_REDIRECTS: ReadonlySet<number> = new Set([307, 308]);
const SEE_OTHER = 303;

/**
 * Headers that carry no credential and describe the request rather than the caller, so they
 * still mean the same thing to a different origin. Everything else is dropped on a
 * cross-origin hop.
 */
const CROSS_ORIGIN_SAFE_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-charset",
  "accept-language",
  "cache-control",
  "content-language",
  "content-type",
  "user-agent",
]);

const BODY_HEADERS: readonly string[] = ["content-type", "content-length", "content-encoding"];

/** Resolves a hostname to every address it currently has. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: HostResolver = async (hostname) => {
  const answers = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

/** A request refused before it left the machine, with the reason the model should read. */
export class EgressRefusedError extends Error {
  override readonly name = "EgressRefusedError";
}

/** Destination policy for one model-directed request. */
export interface EgressPolicy {
  /** The agent's `network.allowPrivateHosts` entries. */
  readonly allowPrivateHosts?: readonly string[];
  /** Replaces system DNS; tests pass a fixed table. */
  readonly resolveHost?: HostResolver;
}

/** The private-network allowlist of the agent running this tool call, if any. */
export function egressPolicyForContext(context: ToolExecutionContext | undefined): EgressPolicy {
  const allowPrivateHosts = context?.parentAgent?.config.network?.allowPrivateHosts;
  return allowPrivateHosts !== undefined ? { allowPrivateHosts } : {};
}

function refusalFor(host: string, address: string, addressClass: string): EgressRefusedError {
  const target = host === address ? address : `${host} (${address})`;
  return new EgressRefusedError(
    `Refused to connect to ${target}: it is a ${addressClass} address. ` +
      `List the host in the agent's network.allowPrivateHosts to reach it.`,
  );
}

async function assertDestinationAllowed(
  url: URL,
  allowlist: PrivateHostAllowlist,
  resolveHost: HostResolver,
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressRefusedError(`Only http and https URLs are supported, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new EgressRefusedError("URLs with embedded credentials are not supported.");
  }

  const host = normalizeHostname(url.hostname);
  if (isIpLiteral(host)) {
    const addressClass = classifyAddress(host);
    if (addressClass !== "public" && !allowlist.allowsAddress(host)) {
      throw refusalFor(host, host, addressClass);
    }
    return;
  }

  if (allowlist.allowsHostname(host)) {
    return;
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveHost(unbracketHost(host));
  } catch (error) {
    throw new EgressRefusedError(
      `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (addresses.length === 0) {
    throw new EgressRefusedError(`Could not resolve ${host}: no addresses.`);
  }
  for (const address of addresses) {
    const addressClass = classifyAddress(address);
    if (addressClass !== "public" && !allowlist.allowsAddress(address)) {
      throw refusalFor(host, address, addressClass);
    }
  }
}

/**
 * Refuse `url` when it points at a destination the policy does not allow.
 *
 * Exposed for callers that hand the connection to something else (a headless browser) and only
 * need the verdict.
 */
export async function checkEgressDestination(url: URL, policy: EgressPolicy = {}): Promise<void> {
  await assertDestinationAllowed(
    url,
    parsePrivateHostAllowlist(policy.allowPrivateHosts),
    policy.resolveHost ?? systemResolver,
  );
}

/** One model-directed request. */
export interface GuardedRequest extends EgressPolicy {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | null;
  readonly signal?: AbortSignal;
  /** Default true. False returns the first 3xx response as-is. */
  readonly followRedirects?: boolean;
}

/** The final response and the URL it came from after any redirects. */
export interface GuardedResponse {
  readonly response: Response;
  readonly url: string;
  readonly redirects: number;
}

function withoutHeaders(
  headers: Readonly<Record<string, string>>,
  keep: (lowerName: string) => boolean,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (keep(name.toLowerCase())) {
      kept[name] = value;
    }
  }
  return kept;
}

/**
 * Fetch `input` with the destination checks, manual redirects and credential stripping described
 * at the top of this module.
 *
 * Throws `EgressRefusedError` when a hop is refused, and whatever `fetch` throws otherwise.
 */
export async function guardedFetch(
  input: string,
  request: GuardedRequest = {},
): Promise<GuardedResponse> {
  const allowlist = parsePrivateHostAllowlist(request.allowPrivateHosts);
  const resolveHost = request.resolveHost ?? systemResolver;
  const followRedirects = request.followRedirects ?? true;

  let url = new URL(input);
  let method = (request.method ?? "GET").toUpperCase();
  let headers: Record<string, string> = { ...(request.headers ?? {}) };
  let body = request.body ?? null;

  for (let redirects = 0; ; redirects++) {
    await assertDestinationAllowed(url, allowlist, resolveHost);

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      redirect: "manual",
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const location = response.headers.get("location");
    if (!followRedirects || !REDIRECT_STATUSES.has(response.status) || location === null) {
      return { response, url: url.toString(), redirects };
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return { response, url: url.toString(), redirects };
    }

    const crossOrigin = next.origin !== url.origin;
    const keepsBody = BODY_PRESERVING_REDIRECTS.has(response.status) && body !== null;
    if (crossOrigin && keepsBody) {
      return { response, url: url.toString(), redirects };
    }
    if (redirects + 1 > MAX_REDIRECT_HOPS) {
      await response.body?.cancel().catch(() => undefined);
      throw new EgressRefusedError(
        `Stopped after ${String(MAX_REDIRECT_HOPS)} redirects from ${input}.`,
      );
    }

    await response.body?.cancel().catch(() => undefined);

    const switchesToGet =
      (response.status === SEE_OTHER && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (switchesToGet) {
      method = "GET";
      body = null;
      headers = withoutHeaders(headers, (name) => !BODY_HEADERS.includes(name));
    }
    if (crossOrigin) {
      headers = withoutHeaders(headers, (name) => CROSS_ORIGIN_SAFE_HEADERS.has(name));
    }
    url = next;
  }
}

/** A response body read up to a byte budget. */
export interface BudgetedBody {
  readonly bytes: Uint8Array;
  /** More bytes were available than the budget allowed; the rest was never read. */
  readonly truncated: boolean;
}

/**
 * Stream `response`'s body into memory, stopping at `maxBytes`.
 *
 * The stream is cancelled at the cap, so an endless or oversized body costs at most `maxBytes`
 * of memory. Abort the request's signal to bound the time as well.
 */
export async function readBodyWithinBudget(
  response: Response,
  maxBytes: number,
): Promise<BudgetedBody> {
  const stream = response.body;
  if (stream === null) {
    return { bytes: new Uint8Array(0), truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = maxBytes - received;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        received += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
