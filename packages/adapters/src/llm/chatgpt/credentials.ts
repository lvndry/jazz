/**
 * Keyring storage for the ChatGPT sign-in, and the refresh path every model request goes through.
 *
 * Two modes, chosen once at startup from the environment:
 *
 * - Sign-in (the default): the full credential lives in the keyring (bootstrapped from
 *   `JAZZ_CHATGPT_CREDENTIAL` in CI) and is refreshed under a cross-process lock when the access
 *   token nears expiry. `JAZZ_CHATGPT_CREDENTIAL_OUTPUT` receives every rotated credential.
 * - Access token only: `JAZZ_CHATGPT_ACCESS_TOKEN` holds a bare access token that another process
 *   keeps fresh. Jazz uses it until it expires or the server refuses it, and never refreshes,
 *   stores or rotates anything, so many runs can share one token while a single place owns the
 *   single-use refresh token.
 *
 * `getChatGPTCredential` serves model requests in both modes. Its `minValidityMs` option asks for a
 * token that stays valid that long, which `jazz config refresh-chatgpt` uses to renew a credential
 * well ahead of the runs that will borrow its access token.
 */

import { CHATGPT_SIGN_IN_HINT } from "@jazz/core/constants/provider-env-vars";
import { CHATGPT_CREDENTIAL_PATH } from "@jazz/core/secrets/registry";
import { clearRuntimeSecret, registerRuntimeSecret } from "@jazz/core/secrets/runtime-secrets";
import { writeFileDurably } from "@jazz/core/utils/durable-file";
import { FILE_LOCK_MAX_WAIT_MS, withFileLock } from "@jazz/core/utils/file-lock";
import { getChatGptCredentialLockPath } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import {
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringSet,
} from "@/adapters/secrets/keyring";
import {
  type ChatGPTAccess,
  type ChatGPTCredential,
  ChatGPTTokenRejectedError,
  readAccessTokenClaims,
  refreshChatGPTCredential,
} from "./oauth";

/** Outside the `llm.<provider>.api_key` namespace the config service resolves as secrets. */
const CREDENTIAL_ACCOUNT = CHATGPT_CREDENTIAL_PATH;
const ACCESS_REDACTION_NAME = "chatgpt-access-token";
const REFRESH_REDACTION_NAME = "chatgpt-refresh-token";

function registerCredentialSecrets(credential: ChatGPTCredential | undefined): void {
  registerRuntimeSecret(ACCESS_REDACTION_NAME, credential?.access ?? "");
  registerRuntimeSecret(REFRESH_REDACTION_NAME, credential?.refresh ?? "");
}

export const CHATGPT_ACCESS_TOKEN_ENV_VAR = "JAZZ_CHATGPT_ACCESS_TOKEN";

/** CI inputs and the refresh output are captured once, then removed from child environments. */
let bootstrapCredentialRaw = process.env["JAZZ_CHATGPT_CREDENTIAL"];
delete process.env["JAZZ_CHATGPT_CREDENTIAL"];
const credentialOutputPath = process.env["JAZZ_CHATGPT_CREDENTIAL_OUTPUT"];
delete process.env["JAZZ_CHATGPT_CREDENTIAL_OUTPUT"];
const accessTokenRaw = process.env[CHATGPT_ACCESS_TOKEN_ENV_VAR];
delete process.env[CHATGPT_ACCESS_TOKEN_ENV_VAR];

/**
 * Refresh this long before the access token expires, so a request that starts just before expiry
 * does not reach the server with a dead token.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Cap on the token-refresh request, which runs while holding the credential lock. */
const REFRESH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * How long to wait for the credential lock: a sign-out queued behind the slowest refresh, on
 * top of the shared lock's own crash-recovery budget.
 */
const LOCK_WAIT_DEADLINE_MS = FILE_LOCK_MAX_WAIT_MS + REFRESH_REQUEST_TIMEOUT_MS;

export const CHATGPT_SIGN_IN_REQUIRED_MESSAGE = `Not signed in to ChatGPT. ${CHATGPT_SIGN_IN_HINT}`;

export class ChatGPTSignInRequiredError extends Error {
  constructor(detail?: string) {
    super(
      detail ? `${CHATGPT_SIGN_IN_REQUIRED_MESSAGE} (${detail})` : CHATGPT_SIGN_IN_REQUIRED_MESSAGE,
    );
    this.name = "ChatGPTSignInRequiredError";
  }
}

/**
 * The access token from `JAZZ_CHATGPT_ACCESS_TOKEN` cannot serve a request: it expired, the server
 * refused it, or it is not a ChatGPT access token. Jazz never refreshes such a token, so the only
 * remedy is a new run with a fresh one.
 */
export class ChatGPTAccessTokenAuthenticationError extends Error {
  constructor(detail: string) {
    super(
      `ChatGPT authentication failed: ${detail} Jazz never refreshes a token given in ${CHATGPT_ACCESS_TOKEN_ENV_VAR}; start the run again with a fresh one.`,
    );
    this.name = "ChatGPTAccessTokenAuthenticationError";
  }
}

function parseCredential(raw: string | undefined): ChatGPTCredential | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  try {
    const value = JSON.parse(raw) as Partial<ChatGPTCredential>;
    if (
      typeof value.access === "string" &&
      typeof value.refresh === "string" &&
      typeof value.expires === "number" &&
      typeof value.accountId === "string"
    ) {
      return value as ChatGPTCredential;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Where the serialized credential is kept. */
export interface CredentialStorage {
  readonly read: () => Promise<string | undefined>;
  /** Resolves to false when nothing could be stored. */
  readonly write: (value: string) => Promise<boolean>;
  readonly remove: () => Promise<void>;
}

const keyringStorage: CredentialStorage = {
  read: async () => {
    const backend = await Effect.runPromise(detectKeyringBackend());
    const stored = await Effect.runPromise(keyringGet(backend, CREDENTIAL_ACCOUNT));
    if (stored !== undefined || bootstrapCredentialRaw === undefined) {
      bootstrapCredentialRaw = undefined;
      registerCredentialSecrets(parseCredential(stored));
      return stored;
    }

    const bootstrap = parseCredential(bootstrapCredentialRaw);
    bootstrapCredentialRaw = undefined;
    if (bootstrap === undefined) {
      throw new ChatGPTSignInRequiredError(
        "JAZZ_CHATGPT_CREDENTIAL must contain a valid copied ChatGPT credential bundle",
      );
    }
    if (
      !(await Effect.runPromise(keyringSet(backend, CREDENTIAL_ACCOUNT, JSON.stringify(bootstrap))))
    ) {
      throw new Error(
        "Could not store the ChatGPT sign-in: no keyring is available (JAZZ_DISABLE_KEYRING is set).",
      );
    }
    registerCredentialSecrets(bootstrap);
    return JSON.stringify(bootstrap);
  },
  write: async (value) => {
    const backend = await Effect.runPromise(detectKeyringBackend());
    const written = await Effect.runPromise(keyringSet(backend, CREDENTIAL_ACCOUNT, value));
    if (written) {
      registerCredentialSecrets(parseCredential(value));
    }
    return written;
  },
  remove: async () => {
    const backend = await Effect.runPromise(detectKeyringBackend());
    await Effect.runPromise(keyringDelete(backend, CREDENTIAL_ACCOUNT));
    clearRuntimeSecret(ACCESS_REDACTION_NAME);
    clearRuntimeSecret(REFRESH_REDACTION_NAME);
  },
};

export interface ChatGPTCredentialStore {
  readonly load: () => Promise<ChatGPTCredential | undefined>;
  /** Record a new sign-in. Waits for any refresh in flight, so it cannot be overwritten. */
  readonly save: (credential: ChatGPTCredential) => Promise<void>;
  /** Sign out. Waits for any refresh in flight, so it cannot be undone. */
  readonly clear: () => Promise<void>;
  /**
   * A usable access token for the next request, refreshing it when it is close to expiry.
   * Concurrent callers in one process share a single refresh.
   *
   * @param options.rejectedAccess - An access token the server just refused; refresh even if it
   *   looks fresh.
   * @param options.minValidityMs - How long the returned token must stay valid. Defaults to a
   *   few minutes in sign-in mode and to zero for a bare access token.
   */
  readonly get: (options?: GetChatGPTAccessOptions) => Promise<ChatGPTAccess>;
}

export interface GetChatGPTAccessOptions {
  readonly rejectedAccess?: string;
  readonly minValidityMs?: number;
}

/**
 * Sign-in, sign-out and refresh all run under one cross-process lock.
 *
 * OpenAI rotates the refresh token on every refresh and rejects the old one, so two Jazz
 * processes (a chat and a bot, say) refreshing at once would sign each other out, and a refresh
 * that finished after a sign-out or an account switch would write the old account back. Under the
 * lock, whoever goes second sees the first one's result.
 */
export function createChatGPTCredentialStore(dependencies: {
  readonly storage: CredentialStorage;
  readonly refresh: (refreshToken: string, signal: AbortSignal) => Promise<ChatGPTCredential>;
  readonly lockPath: () => string;
  /** Called after a rotated credential has been persisted, for hosted runners to update their secret. */
  readonly onRefresh?: (credential: ChatGPTCredential) => Promise<void>;
}): ChatGPTCredentialStore {
  const { storage, refresh, lockPath, onRefresh } = dependencies;
  let memoized: ChatGPTCredential | undefined;
  let pendingRefresh: Promise<ChatGPTCredential> | undefined;
  /**
   * Bumped by every sign-in and sign-out, so a refresh that started before one does not
   * repopulate the in-memory credential after it.
   */
  let generation = 0;

  const isFresh = (credential: ChatGPTCredential, marginMs: number): boolean =>
    credential.expires - marginMs > Date.now();

  const load = async (): Promise<ChatGPTCredential | undefined> =>
    parseCredential(await storage.read());

  const write = async (credential: ChatGPTCredential): Promise<void> => {
    if (!(await storage.write(JSON.stringify(credential)))) {
      throw new Error(
        "Could not store the ChatGPT sign-in: no keyring is available (JAZZ_DISABLE_KEYRING is set).",
      );
    }
  };

  function locked<A>(operation: () => Promise<A>): Promise<A> {
    return withFileLock(lockPath(), operation, { maxWaitMs: LOCK_WAIT_DEADLINE_MS });
  }

  const refreshUnderLock = (
    rejectedAccess: string | undefined,
    marginMs: number,
  ): Promise<ChatGPTCredential> =>
    locked(async () => {
      const stored = await load();
      if (stored === undefined) {
        throw new ChatGPTSignInRequiredError();
      }
      if (isFresh(stored, marginMs) && stored.access !== rejectedAccess) {
        return stored;
      }
      let refreshed: ChatGPTCredential;
      try {
        refreshed = await refresh(stored.refresh, AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS));
      } catch (error) {
        // A 4xx means the refresh token is dead and only a new sign-in helps. Anything else
        // (offline, a 5xx, the timeout) is transient and surfaces as itself.
        if (error instanceof ChatGPTTokenRejectedError && error.status < 500) {
          throw new ChatGPTSignInRequiredError(error.message);
        }
        throw error;
      }
      // Only replace the credential that was refreshed. If the lock was reclaimed as stale and a
      // sign-out or sign-in landed meanwhile, their result stands.
      const current = await load();
      if (current?.refresh !== stored.refresh) {
        if (current === undefined) {
          throw new ChatGPTSignInRequiredError();
        }
        return current;
      }
      await write(refreshed);
      await onRefresh?.(refreshed);
      return refreshed;
    });

  return {
    load,
    save: (credential) =>
      locked(async () => {
        await write(credential);
        generation += 1;
        memoized = credential;
      }),
    clear: () =>
      locked(async () => {
        await storage.remove();
        generation += 1;
        memoized = undefined;
      }),
    get: async (options) => {
      const rejectedAccess = options?.rejectedAccess;
      const marginMs = Math.max(options?.minValidityMs ?? 0, REFRESH_MARGIN_MS);
      if (
        memoized !== undefined &&
        isFresh(memoized, marginMs) &&
        memoized.access !== rejectedAccess
      ) {
        return memoized;
      }
      if (memoized === undefined && rejectedAccess === undefined) {
        const stored = await load();
        if (stored !== undefined && isFresh(stored, marginMs)) {
          memoized = stored;
          return stored;
        }
      }
      if (pendingRefresh === undefined) {
        const startedAt = generation;
        pendingRefresh = refreshUnderLock(rejectedAccess, marginMs).then(
          (credential) => {
            if (generation === startedAt) {
              memoized = credential;
            }
            pendingRefresh = undefined;
            return credential;
          },
          (error: unknown) => {
            pendingRefresh = undefined;
            throw error;
          },
        );
      }
      return pendingRefresh;
    },
  };
}

/** A store whose every call fails with `error`, for a configuration Jazz cannot act on. */
function unavailableStore(error: Error): ChatGPTCredentialStore {
  const fail = (): Promise<never> => Promise.reject(error);
  return { load: fail, save: fail, clear: fail, get: fail };
}

/**
 * A store that serves one access token handed in from outside and never refreshes it. The
 * token's own `exp` and account claims say how long it lasts and whom it acts for.
 *
 * @param now - The clock, for tests.
 */
export function createAccessTokenStore(
  accessToken: string,
  now: () => number = Date.now,
): ChatGPTCredentialStore {
  const claims = readAccessTokenClaims(accessToken);
  if (claims.accountId === undefined || claims.expires === undefined) {
    return unavailableStore(
      new ChatGPTAccessTokenAuthenticationError(
        `${CHATGPT_ACCESS_TOKEN_ENV_VAR} is not a ChatGPT access token with an account and an expiry.`,
      ),
    );
  }
  const access: ChatGPTAccess = {
    access: accessToken,
    expires: claims.expires,
    accountId: claims.accountId,
    ...(claims.plan !== undefined ? { plan: claims.plan } : {}),
  };
  const signInUnavailable = (): Promise<never> =>
    Promise.reject(
      new Error(
        `Jazz was started with ${CHATGPT_ACCESS_TOKEN_ENV_VAR}, so it cannot sign in, sign out or read a stored ChatGPT sign-in.`,
      ),
    );
  return {
    load: signInUnavailable,
    save: signInUnavailable,
    clear: signInUnavailable,
    get: (options) => {
      if (options?.rejectedAccess === accessToken) {
        return Promise.reject(
          new ChatGPTAccessTokenAuthenticationError("ChatGPT refused the access token."),
        );
      }
      const minValidityMs = options?.minValidityMs ?? 0;
      if (access.expires - minValidityMs <= now()) {
        const expiry = new Date(access.expires).toISOString();
        return Promise.reject(
          new ChatGPTAccessTokenAuthenticationError(
            minValidityMs > 0
              ? `the access token expires at ${expiry}, sooner than the ${Math.ceil(minValidityMs / 60_000)} minutes asked for.`
              : `the access token expired at ${expiry}.`,
          ),
        );
      }
      return Promise.resolve(access);
    },
  };
}

function createDefaultStore(): ChatGPTCredentialStore {
  if (accessTokenRaw !== undefined && accessTokenRaw.trim() !== "") {
    if (bootstrapCredentialRaw !== undefined) {
      return unavailableStore(
        new Error(
          `Set either ${CHATGPT_ACCESS_TOKEN_ENV_VAR} or JAZZ_CHATGPT_CREDENTIAL, not both: one run either owns the sign-in or borrows its access token.`,
        ),
      );
    }
    const accessToken = accessTokenRaw.trim();
    registerRuntimeSecret(ACCESS_REDACTION_NAME, accessToken);
    return createAccessTokenStore(accessToken);
  }
  return createChatGPTCredentialStore({
    storage: keyringStorage,
    refresh: refreshChatGPTCredential,
    lockPath: getChatGptCredentialLockPath,
    ...(credentialOutputPath === undefined
      ? {}
      : {
          onRefresh: (credential: ChatGPTCredential) =>
            writeFileDurably(credentialOutputPath, `${JSON.stringify(credential)}\n`, {
              mode: 0o600,
            }),
        }),
  });
}

const defaultStore = createDefaultStore();

export const loadChatGPTCredential = defaultStore.load;
export const saveChatGPTCredential = defaultStore.save;
export const clearChatGPTCredential = defaultStore.clear;
export const getChatGPTCredential = defaultStore.get;
