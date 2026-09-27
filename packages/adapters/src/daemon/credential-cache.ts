/**
 * @fileoverview Remembering door credentials for a short while, instead of reading the keyring
 * on every request.
 *
 * A keyring read spawns `security` or `secret-tool`, and the peer door tries every configured
 * peer's token until one matches. Uncached, one request with a wrong token cost one subprocess
 * per peer, which let anyone who can reach the port make the daemon fork at will.
 *
 * Each name's value (including "no credential") is kept for {@link CREDENTIAL_CACHE_TTL_MS}, and
 * concurrent lookups of one name share one read. A peer added by accepting an invite has a new
 * name, so it is read fresh at once; a token changed for an existing name takes effect within
 * the TTL.
 */

/**
 * How long a credential read from the keyring is trusted.
 *
 * Long enough that a burst of requests costs one read per name, short enough that rotating a
 * token with `jazz peers set-token` or `jazz webhook token` takes effect without a restart.
 */
export const CREDENTIAL_CACHE_TTL_MS = 30_000;

interface CachedCredential {
  readonly value: Promise<string | undefined>;
  readonly expiresAt: number;
}

/** `resolve`, remembering each name's answer for `ttlMs`. */
export function cacheCredentialResolver(
  resolve: (name: string) => Promise<string | undefined>,
  ttlMs: number = CREDENTIAL_CACHE_TTL_MS,
  now: () => number = Date.now,
): (name: string) => Promise<string | undefined> {
  const cache = new Map<string, CachedCredential>();
  return (name) => {
    const cached = cache.get(name);
    if (cached !== undefined && cached.expiresAt > now()) {
      return cached.value;
    }
    const value = resolve(name).catch((error: unknown) => {
      cache.delete(name);
      throw error;
    });
    cache.set(name, { value, expiresAt: now() + ttlMs });
    return value;
  };
}
