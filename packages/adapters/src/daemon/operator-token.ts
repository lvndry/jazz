/**
 * @fileoverview The operator token: a second daemon credential that only the person who owns
 * this machine can present, required for every HTTP request that grants authority.
 *
 * The daemon token authenticates a client of the daemon. It cannot tell the operator from an
 * agent: it lives in `$JAZZ_DAEMON_TOKEN` or in `$JAZZ_HOME/secrets.json` on a host with no OS
 * keyring, and an agent with only `read_file` and `http_request` can read either and replay it.
 * Before this token existed, that was enough to accept its own goal with `high-risk`, start a
 * loop with any policy, or approve its own parked run.
 *
 * So the routes that grant (see `operatorGrantRefusal` in `server.ts`) also need this token, and
 * it is kept where an agent's read tools cannot reach:
 *
 * - **Only in the OS keyring** (the macOS keychain or the Linux Secret Service). Never in the
 *   `secrets.json` file fallback, and never in an environment variable, since a process's
 *   environment is readable at `/proc/<pid>/environ` by anything running as the same user.
 * - **Minted only by a person**: `jazz daemon operator-token` refuses to run inside a process a
 *   Jazz agent started, and prints the value once.
 * - **Never loaded into the app config**, so nothing that prints config can echo it.
 *
 * A host with no OS keyring has no operator token, and its daemon grants nothing over HTTP. The
 * CLI on that machine (`jazz runs approve`, `jazz goal accept`, `jazz loop start`) acts on the
 * stores directly and needs no daemon at all.
 *
 * An agent with a shell can ask the keychain for this entry itself, but an agent with a shell
 * already holds more than any grant could give it. The token closes the escalation from
 * read-and-egress tools to high-risk, which is the one that mattered.
 */

import { randomBytes } from "node:crypto";
import { DAEMON_OPERATOR_TOKEN_PATH } from "@jazz/core/secrets/registry";
import { Effect } from "effect";
import {
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringSet,
  type KeyringBackend,
} from "@/adapters/secrets/keyring";

/** Request header carrying the operator token. */
export const OPERATOR_TOKEN_HEADER = "x-jazz-operator-token";

/** Matches the daemon token: 192 bits. */
const OPERATOR_TOKEN_BYTES = 24;

/** Backends that keep a secret out of reach of a file read. */
export function holdsOperatorToken(backend: KeyringBackend): boolean {
  return backend === "macos" || backend === "libsecret";
}

/** The stored operator token, or `undefined` when there is none or no OS keyring to hold one. */
export function resolveOperatorToken(): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const backend = yield* detectKeyringBackend();
    if (!holdsOperatorToken(backend)) {
      return undefined;
    }
    return yield* keyringGet(backend, DAEMON_OPERATOR_TOKEN_PATH);
  });
}

export type OperatorTokenProvision =
  | { readonly ok: true; readonly token: string; readonly backend: KeyringBackend }
  | { readonly ok: false; readonly reason: "no-os-keyring" | "write-failed" };

/** Generate a new operator token and store it in the OS keyring, replacing any old one. */
export function provisionOperatorToken(): Effect.Effect<OperatorTokenProvision, never> {
  return Effect.gen(function* () {
    const backend = yield* detectKeyringBackend();
    if (!holdsOperatorToken(backend)) {
      return { ok: false, reason: "no-os-keyring" } as const;
    }
    const token = randomBytes(OPERATOR_TOKEN_BYTES).toString("hex");
    const stored = yield* keyringSet(backend, DAEMON_OPERATOR_TOKEN_PATH, token);
    return stored
      ? ({ ok: true, token, backend } as const)
      : ({ ok: false, reason: "write-failed" } as const);
  });
}

/** Remove the stored operator token, so the daemon grants nothing over HTTP. */
export function forgetOperatorToken(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const backend = yield* detectKeyringBackend();
    if (holdsOperatorToken(backend)) {
      yield* keyringDelete(backend, DAEMON_OPERATOR_TOKEN_PATH);
    }
  });
}
