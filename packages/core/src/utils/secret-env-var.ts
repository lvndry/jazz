/**
 * @fileoverview The environment variable name a configured door's secret is read from.
 *
 * Peers and webhooks are named by the operator, and each name becomes part of an environment
 * variable (`JAZZ_PEER_TOKEN_<SUFFIX>`, `JAZZ_WEBHOOK_TOKEN_<SUFFIX>`). The mapping folds case and
 * every character outside `[A-Za-z0-9]` to `_`, so `a.b`, `a_b` and `A-b` all read one variable.
 * The config schema refuses two doors of one kind whose names share a suffix
 * ({@link secretEnvVarSuffix}), since otherwise one door's secret would authenticate the other.
 */

/** The part of a door's secret variable name that comes from its configured name. */
export function secretEnvVarSuffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
