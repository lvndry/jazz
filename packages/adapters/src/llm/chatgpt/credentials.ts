/**
 * Keyring storage for the ChatGPT sign-in, and the refresh path every model request goes through.
 */

import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { withLock } from "@jazz/core/utils/storage";
import { Effect, Either } from "effect";
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

export async function loadChatGPTCredential(): Promise<ChatGPTCredential | undefined> {
  const backend = await Effect.runPromise(detectKeyringBackend());
  return parseCredential(await Effect.runPromise(keyringGet(backend, CREDENTIAL_ACCOUNT)));
}

export async function saveChatGPTCredential(credential: ChatGPTCredential): Promise<void> {
  const backend = await Effect.runPromise(detectKeyringBackend());
  const saved = await Effect.runPromise(
    keyringSet(backend, CREDENTIAL_ACCOUNT, JSON.stringify(credential)),
  );
  if (!saved) {
    throw new Error(
      "Could not store the ChatGPT sign-in: no keyring is available (JAZZ_DISABLE_KEYRING is set).",
    );
  }
  memoized = credential;
}

export async function clearChatGPTCredential(): Promise<void> {
  const backend = await Effect.runPromise(detectKeyringBackend());
  await Effect.runPromise(keyringDelete(backend, CREDENTIAL_ACCOUNT));
  memoized = undefined;
}

let memoized: ChatGPTCredential | undefined;
let pendingRefresh: Promise<ChatGPTCredential> | undefined;

function isFresh(credential: ChatGPTCredential): boolean {
  return credential.expires - REFRESH_MARGIN_MS > Date.now();
}

/**
 * Refresh under a cross-process lock, re-reading the keyring first.
 *
 * OpenAI rotates the refresh token on every refresh and rejects the old one, so two Jazz
 * processes (a chat and a bot, say) refreshing at the same moment would sign each other out.
 * Whoever takes the lock second finds the other's fresh credential and uses it.
 *
 * @param rejectedAccess - An access token the server just refused; refresh even if it looks fresh.
 */
async function refreshUnderLock(rejectedAccess?: string): Promise<ChatGPTCredential> {
  const lockPath = path.join(getJazzHomeDirectory(), ".chatgpt-refresh.lock");
  const refresh = Effect.tryPromise({
    try: async () => {
      const stored = await loadChatGPTCredential();
      if (stored === undefined) {
        throw new ChatGPTSignInRequiredError();
      }
      if (isFresh(stored) && stored.access !== rejectedAccess) {
        return stored;
      }
      let refreshed: ChatGPTCredential;
      try {
        refreshed = await refreshChatGPTCredential(stored.refresh);
      } catch (error) {
        // A 4xx means the refresh token is dead and only a new sign-in helps. Anything else
        // (offline, a 5xx) is transient and surfaces as itself.
        if (error instanceof ChatGPTTokenRejectedError && error.status < 500) {
          throw new ChatGPTSignInRequiredError(error.message);
        }
        throw error;
      }
      await saveChatGPTCredential(refreshed);
      return refreshed;
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
  // `runPromise` would wrap a failure in a FiberFailure and hide the sign-in error's type.
  const outcome = await Effect.runPromise(
    Effect.either(withLock(lockPath, refresh)).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (Either.isLeft(outcome)) {
    throw outcome.left;
  }
  return outcome.right;
}

/**
 * A usable credential for the next request, refreshing it when it is close to expiry. Concurrent
 * callers in one process share a single refresh.
 */
export async function getChatGPTCredential(options?: {
  readonly rejectedAccess?: string;
}): Promise<ChatGPTCredential> {
  const rejectedAccess = options?.rejectedAccess;
  if (memoized !== undefined && isFresh(memoized) && memoized.access !== rejectedAccess) {
    return memoized;
  }
  if (memoized === undefined && rejectedAccess === undefined) {
    const stored = await loadChatGPTCredential();
    if (stored !== undefined && isFresh(stored)) {
      memoized = stored;
      return stored;
    }
  }
  pendingRefresh ??= refreshUnderLock(rejectedAccess).then(
    (credential) => {
      memoized = credential;
      pendingRefresh = undefined;
      return credential;
    },
    (error: unknown) => {
      pendingRefresh = undefined;
      throw error;
    },
  );
  return pendingRefresh;
}
