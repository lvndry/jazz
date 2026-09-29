/**
 * The one `fetch` for URLs a model chose.
 *
 * `http_request`, `web_fetch`, `read_pdf` and the headless renderers all send requests to
 * addresses that came out of a model, which means out of whatever the model last read. This
 * module is the single place those requests go through, and it enforces four things plain
 * `fetch` does not:
 *
 * HTTP tools pass their scoped global policy: unrestricted by default, or URL grants checked
 * on every hop. Those grants allow private destinations without widening other tools.
 *
 * 1. **Public destinations for other tools.** The hostname is resolved and every address it resolves to
 *    must be public (see `classifyAddress`), unless the global `network.allowPrivateHosts` or
 *    an approval for this call lists the hostname or the address. Loopback, RFC 1918,
 *    link-local (including the cloud metadata service at 169.254.169.254), CGNAT, IPv4-mapped
 *    IPv6 and `0.0.0.0` are refused. The executor asks for approval before a call whose URL
 *    reaches an unlisted private address (see `unlistedPrivateAddresses`).
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
import { Effect } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { ToolExecutionContext } from "@/core/types";
import type { HttpApprovalPolicy } from "@/core/types/config";
import { httpUrlIsApproved, isHttpApprovalTool } from "@/core/utils/http-approval";
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
  /** Scoped to the two HTTP tools; grants both public and private destinations. */
  readonly httpApproval?: HttpApprovalPolicy;
  /** Exact URL the person approved for this call. */
  readonly approvedHttpUrl?: string;
  /** `network.allowPrivateHosts` entries, plus any addresses approved for this call. */
  readonly allowPrivateHosts?: readonly string[];
  /** Replaces system DNS; tests pass a fixed table. */
  readonly resolveHost?: HostResolver;
}

/**
 * The private hosts this tool call may reach: the global `network.allowPrivateHosts`, plus the
 * addresses a person or the run's policy approved for this call.
 */
export function egressPolicyForContext(
  context: ToolExecutionContext | undefined,
  toolName?: string,
): Effect.Effect<EgressPolicy, never, AgentConfigService> {
  return Effect.gen(function* () {
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const allowPrivateHosts = [
      ...(appConfig.network?.allowPrivateHosts ?? []),
      ...(context?.approvedPrivateAddresses ?? []),
    ];
    return {
      ...(allowPrivateHosts.length > 0 ? { allowPrivateHosts } : {}),
      ...(toolName !== undefined && isHttpApprovalTool(toolName)
        ? {
            httpApproval: context?.httpApproval ?? appConfig.network?.httpApproval ?? "allow",
            ...(context?.approvedHttpUrl !== undefined
              ? { approvedHttpUrl: context.approvedHttpUrl }
              : {}),
          }
        : {}),
    };
  });
}

function refusalFor(host: string, address: string, addressClass: string): EgressRefusedError {
  const target = host === address ? address : `${host} (${address})`;
  return new EgressRefusedError(
    `Refused to connect to ${target}: it is a ${addressClass} address. ` +
      `To reach it, call the tool again with that URL directly so the user can approve it.`,
  );
}

/** A private address `url` would reach, and what kind of address it is. */
export interface PrivateDestination {
  readonly address: string;
  readonly addressClass: string;
}

async function privateDestinations(
  host: string,
  allowlist: PrivateHostAllowlist,
  resolveHost: HostResolver,
): Promise<readonly PrivateDestination[]> {
  if (isIpLiteral(host)) {
    const addressClass = classifyAddress(host);
    return addressClass !== "public" && !allowlist.allowsAddress(host)
      ? [{ address: host, addressClass }]
      : [];
  }
  if (allowlist.allowsHostname(host)) {
    return [];
  }
  const addresses = await resolveHost(unbracketHost(host));
  if (addresses.length === 0) {
    throw new EgressRefusedError(`Could not resolve ${host}: no addresses.`);
  }
  return addresses.flatMap((address) => {
    const addressClass = classifyAddress(address);
    return addressClass !== "public" && !allowlist.allowsAddress(address)
      ? [{ address, addressClass }]
      : [];
  });
}

/**
 * The private addresses `url` would reach that `policy` does not list: what a person has to
 * approve before the request is sent. Empty for a public destination, and for a URL the fetch
 * itself will refuse (not http(s), unresolvable), which then reports its own error.
 */
export async function unlistedPrivateAddresses(
  url: string,
  policy: EgressPolicy = {},
): Promise<readonly PrivateDestination[]> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return [];
    }
    return await privateDestinations(
      normalizeHostname(parsed.hostname),
      parsePrivateHostAllowlist(policy.allowPrivateHosts),
      policy.resolveHost ?? systemResolver,
    );
  } catch {
    return [];
  }
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
  let refused: readonly PrivateDestination[];
  try {
    refused = await privateDestinations(host, allowlist, resolveHost);
  } catch (error) {
    if (error instanceof EgressRefusedError) {
      throw error;
    }
    throw new EgressRefusedError(
      `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const first = refused[0];
  if (first !== undefined) {
    throw refusalFor(host, first.address, first.addressClass);
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
    if (request.httpApproval !== undefined) {
      if (!httpUrlIsApproved(url.toString(), request.httpApproval, request.approvedHttpUrl)) {
        throw new EgressRefusedError(
          "This URL needs approval under network.httpApproval. Request it directly to approve this call.",
        );
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new EgressRefusedError("Only http and https URLs are supported.");
      }
      if (url.username !== "" || url.password !== "") {
        throw new EgressRefusedError("URLs with embedded credentials are not supported.");
      }
    } else {
      await assertDestinationAllowed(url, allowlist, resolveHost);
    }

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
