/**
 * Resolves the externally advertised origin for peer invitations. Explicit public URLs and
 * hosts bypass discovery; otherwise a bounded HTTPS request obtains the public IPv4 address.
 * This selects an address only: it never changes the daemon bind, firewall, or router.
 */
import { isIP } from "node:net";
import { CLIError } from "@jazz/core/types/errors";
import { toError } from "@jazz/core/utils/errors";
import { Effect } from "effect";

const PUBLIC_IP_ENDPOINT = "https://api.ipify.org";
const PUBLIC_IP_TIMEOUT_MS = 5_000;
const MAX_PUBLIC_IP_BYTES = 64;

export interface PeerInviteAddressOptions {
  readonly host?: string;
  readonly port: number;
  readonly publicUrl?: string;
}

type AddressFetch = (url: string, options: RequestInit) => Promise<Response>;

async function detectPublicIp(fetchAddress: AddressFetch): Promise<string> {
  const response = await fetchAddress(PUBLIC_IP_ENDPOINT, {
    signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error("public IP lookup did not return an address");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PUBLIC_IP_BYTES) throw new Error("public IP lookup returned too much data");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const address = body.trim();
  if (isIP(address) !== 4) throw new Error("public IP lookup returned an invalid IPv4 address");
  return address;
}

/** Validates overrides before any network request; lookup failures never fall back to loopback. */
export function resolvePeerInviteOrigin(
  options: PeerInviteAddressOptions,
  fetchAddress: AddressFetch = fetch,
): Effect.Effect<string, CLIError> {
  return Effect.tryPromise({
    try: async () => {
      if (options.publicUrl !== undefined) {
        const url = new URL(options.publicUrl);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.pathname !== "/" ||
          url.search !== "" ||
          url.hash !== "" ||
          url.username !== "" ||
          url.password !== ""
        )
          throw new Error(
            "--public-url must be an HTTP(S) origin without a path, query, fragment, or credentials",
          );
        return url.origin;
      }
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
        throw new Error("--port must be between 1 and 65535");
      }
      const host = options.host ?? (await detectPublicIp(fetchAddress));
      const authority = isIP(host) === 6 ? `[${host}]` : host;
      const url = new URL(`http://${authority}:${String(options.port)}`);
      if (
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        (url.port !== String(options.port) && options.port !== 80)
      ) {
        throw new Error("--host must be an IP address or hostname without a scheme, port, or path");
      }
      return url.origin;
    },
    catch: (error) =>
      new CLIError({
        command: "peers invite create",
        message: `Could not resolve the invite address: ${toError(error).message}`,
        suggestion:
          "Pass --host <reachable-ip> or --public-url <origin> to choose the advertised address explicitly.",
      }),
  });
}
