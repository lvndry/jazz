/**
 * Byte-bounded, origin-pinned HTTPS downloads for plugin installation.
 *
 * `fetchWithinOrigins` follows redirects by hand so every hop is checked against an explicit set of
 * HTTPS origins, applies one deadline to the whole chain (headers and body), and stops reading as
 * soon as the body passes its byte limit. `readStreamWithinLimit` is the same cap for any stream,
 * such as a gzip inflate, so a small compressed download cannot expand without bound.
 */

export interface BoundedFetchOptions {
  /** HTTPS origins (`https://host`) the request and every redirect hop must stay on. */
  readonly allowedOrigins: ReadonlySet<string>;
  readonly limitBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

export interface BoundedFetchResult {
  readonly bytes: Uint8Array;
  readonly finalUrl: URL;
  readonly status: number;
}

const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

/** Read a stream fully, cancelling it and throwing `exceededMessage` once it passes `limitBytes`. */
export async function readStreamWithinLimit(
  stream: ReadableStream<Uint8Array>,
  limitBytes: number,
  exceededMessage: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > limitBytes) {
      await reader.cancel(exceededMessage).catch(() => undefined);
      throw new Error(exceededMessage);
    }
    chunks.push(next.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function assertAllowed(url: URL, allowedOrigins: ReadonlySet<string>, what: string): void {
  if (url.protocol !== "https:" || !allowedOrigins.has(url.origin)) {
    throw new Error(`${what} went outside its trusted HTTPS origin: ${url.origin}`);
  }
}

/**
 * GET `source`, following at most `maxRedirects` redirects that stay on `allowedOrigins`. A
 * non-2xx final status is returned with an empty body so callers can word their own error.
 */
export async function fetchWithinOrigins(
  source: URL,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const exceeded = `Download exceeds ${options.limitBytes} bytes`;
  assertAllowed(source, options.allowedOrigins, "Plugin download");
  const signal = AbortSignal.timeout(options.timeoutMs);
  let current = source;
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal,
      ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
    });
    if (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX) {
      const location = response.headers.get("location");
      if (location === null || redirects >= options.maxRedirects) {
        throw new Error("Plugin download has an invalid redirect chain");
      }
      const next = new URL(location, current);
      assertAllowed(next, options.allowedOrigins, "Plugin download redirect");
      await response.body?.cancel().catch(() => undefined);
      current = next;
      continue;
    }
    if (response.url.length > 0) {
      assertAllowed(new URL(response.url), options.allowedOrigins, "Plugin download");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(), finalUrl: current, status: response.status };
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > options.limitBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(exceeded);
    }
    const bytes =
      response.body === null
        ? new Uint8Array()
        : await readStreamWithinLimit(response.body, options.limitBytes, exceeded);
    return { bytes, finalUrl: current, status: response.status };
  }
}
