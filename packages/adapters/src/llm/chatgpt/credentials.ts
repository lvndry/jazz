/**
 * Keyring storage for the ChatGPT sign-in, and the refresh path every model request goes through.
 */

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
  type ChatGPTCredential,
  ChatGPTTokenRejectedError,
  refreshChatGPTCredential,
} from "./oauth";

/** Outside the `llm.<provider>.api_key` namespace the config service resolves as secrets. */
const CREDENTIAL_ACCOUNT = "chatgpt.oauth.credential";

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

export const CHATGPT_SIGN_IN_REQUIRED_MESSAGE =
  "Not signed in to ChatGPT. Run `jazz config`, choose LLM providers, then ChatGPT.";

export class ChatGPTSignInRequiredError extends Error {
  constructor(detail?: string) {
    super(
      detail ? `${CHATGPT_SIGN_IN_REQUIRED_MESSAGE} (${detail})` : CHATGPT_SIGN_IN_REQUIRED_MESSAGE,
    );
    this.name = "ChatGPTSignInRequiredError";
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
    return Effect.runPromise(keyringGet(backend, CREDENTIAL_ACCOUNT));
  },
  write: async (value) => {
    const backend = await Effect.runPromise(detectKeyringBackend());
    return Effect.runPromise(keyringSet(backend, CREDENTIAL_ACCOUNT, value));
  },
  remove: async () => {
    const backend = await Effect.runPromise(detectKeyringBackend());
    await Effect.runPromise(keyringDelete(backend, CREDENTIAL_ACCOUNT));
  },
};

export interface ChatGPTCredentialStore {
  readonly load: () => Promise<ChatGPTCredential | undefined>;
  /** Record a new sign-in. Waits for any refresh in flight, so it cannot be overwritten. */
  readonly save: (credential: ChatGPTCredential) => Promise<void>;
  /** Sign out. Waits for any refresh in flight, so it cannot be undone. */
  readonly clear: () => Promise<void>;
  /**
   * A usable credential for the next request, refreshing it when it is close to expiry.
   * Concurrent callers in one process share a single refresh.
   *
   * @param options.rejectedAccess - An access token the server just refused; refresh even if it
   *   looks fresh.
   */
  readonly get: (options?: { readonly rejectedAccess?: string }) => Promise<ChatGPTCredential>;
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
}): ChatGPTCredentialStore {
  const { storage, refresh, lockPath } = dependencies;
  let memoized: ChatGPTCredential | undefined;
  let pendingRefresh: Promise<ChatGPTCredential> | undefined;
  /**
   * Bumped by every sign-in and sign-out, so a refresh that started before one does not
   * repopulate the in-memory credential after it.
   */
  let generation = 0;

  const isFresh = (credential: ChatGPTCredential): boolean =>
    credential.expires - REFRESH_MARGIN_MS > Date.now();

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

  const refreshUnderLock = (rejectedAccess: string | undefined): Promise<ChatGPTCredential> =>
    locked(async () => {
      const stored = await load();
      if (stored === undefined) {
        throw new ChatGPTSignInRequiredError();
      }
      if (isFresh(stored) && stored.access !== rejectedAccess) {
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
      if (memoized !== undefined && isFresh(memoized) && memoized.access !== rejectedAccess) {
        return memoized;
      }
      if (memoized === undefined && rejectedAccess === undefined) {
        const stored = await load();
        if (stored !== undefined && isFresh(stored)) {
          memoized = stored;
          return stored;
        }
      }
      if (pendingRefresh === undefined) {
        const startedAt = generation;
        pendingRefresh = refreshUnderLock(rejectedAccess).then(
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

const defaultStore = createChatGPTCredentialStore({
  storage: keyringStorage,
  refresh: refreshChatGPTCredential,
  lockPath: getChatGptCredentialLockPath,
});

export const loadChatGPTCredential = defaultStore.load;
export const saveChatGPTCredential = defaultStore.save;
export const clearChatGPTCredential = defaultStore.clear;
export const getChatGPTCredential = defaultStore.get;
