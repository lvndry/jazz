/**
 * `jazz config refresh-chatgpt --min-valid-minutes <minutes>`: make sure the stored ChatGPT
 * sign-in holds an access token that stays valid for at least that long, refreshing it when it
 * does not, then prove the token works with one authenticated catalog request (a refused token is
 * refreshed once there too).
 *
 * It exists for hosted runners that keep one ChatGPT sign-in for many parallel runs. The refresh
 * token is single use, so one serialized step runs this command (with `JAZZ_CHATGPT_CREDENTIAL`
 * and `JAZZ_CHATGPT_CREDENTIAL_OUTPUT`, which receives the rotated credential to save back), and
 * every parallel run then borrows the resulting access token through `JAZZ_CHATGPT_ACCESS_TOKEN`,
 * which never refreshes. The command never prints a token: stdout gets one line with the expiry.
 *
 * Interrupting a refresh after OpenAI rotated the refresh token but before Jazz stored and wrote
 * out the new one would lose the sign-in, so SIGINT and SIGTERM are held until the command
 * finishes (the refresh and the check each have their own timeout) and then end it with the
 * conventional signal exit code.
 */

import { constants } from "node:os";
import {
  type ChatGPTAccess,
  createChatGPTFetch,
  fetchChatGPTModels,
  type GetChatGPTAccessOptions,
  getChatGPTCredential,
} from "@jazz/adapters/llm/chatgpt";

/** Cap on the catalog request that proves the access token works. */
const VERIFY_REQUEST_TIMEOUT_MS = 30_000;

const MINUTE_MS = 60_000;

export interface RefreshChatGPTDependencies {
  readonly getCredential: (options?: GetChatGPTAccessOptions) => Promise<ChatGPTAccess>;
  /** One authenticated request; a 401 makes it refresh through `getCredential` and retry. */
  readonly verify: () => Promise<unknown>;
}

const defaultDependencies: RefreshChatGPTDependencies = {
  getCredential: getChatGPTCredential,
  verify: () =>
    fetchChatGPTModels(
      createChatGPTFetch({
        baseFetch: Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS) }),
          fetch,
        ),
      }),
    ),
};

/**
 * Renew the sign-in if its access token would expire within `minValidityMs`, check that the
 * server accepts the token, and return the access token now in force.
 */
export async function ensureChatGPTAccessValidFor(
  minValidityMs: number,
  dependencies: RefreshChatGPTDependencies = defaultDependencies,
): Promise<ChatGPTAccess> {
  await dependencies.getCredential({ minValidityMs });
  await dependencies.verify();
  return dependencies.getCredential({ minValidityMs });
}

/** Parse `--min-valid-minutes`: a whole number of minutes, zero or more. */
export function parseMinValidMinutes(raw: string): number | undefined {
  if (!/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const minutes = Number(raw.trim());
  return Number.isSafeInteger(minutes) ? minutes : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where shutdown signals arrive: the process, or a stand-in in tests. */
export interface SignalSource {
  readonly on: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown;
  readonly off: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => unknown;
}

export async function runRefreshChatGPTCommand(
  minValidMinutes: string,
  dependencies: RefreshChatGPTDependencies = defaultDependencies,
  signals: SignalSource = process,
): Promise<void> {
  const minutes = parseMinValidMinutes(minValidMinutes);
  if (minutes === undefined) {
    process.stderr.write(
      `--min-valid-minutes takes a whole number of minutes, not "${minValidMinutes}".\n`,
    );
    process.exitCode = 1;
    return;
  }

  let heldSignal: NodeJS.Signals | undefined;
  const hold = (signal: NodeJS.Signals): void => {
    heldSignal ??= signal;
    process.stderr.write(`Received ${signal}: finishing the ChatGPT token check first.\n`);
  };
  signals.on("SIGINT", hold);
  signals.on("SIGTERM", hold);
  try {
    const access = await ensureChatGPTAccessValidFor(minutes * MINUTE_MS, dependencies);
    process.stdout.write(
      `ChatGPT access token valid until ${new Date(access.expires).toISOString()}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    signals.off("SIGINT", hold);
    signals.off("SIGTERM", hold);
  }
  if (heldSignal !== undefined) {
    process.exitCode = 128 + constants.signals[heldSignal];
  }
}
