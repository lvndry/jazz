/**
 * Interactive ChatGPT subscription sign-in and sign-out, shared by `jazz config` and the agent
 * wizards when an agent picks the ChatGPT provider. Pass the terminal and config
 * services to signInToChatGPT to choose browser/device authentication, save tokens
 * through the credential adapter and persist the account summary; it returns false
 * on cancellation or sign-in failure. refreshChatGPTSignIn trades the stored refresh token
 * for a new access token and falls back to signing in when OpenAI has revoked it.
 * signOutOfChatGPT clears both credentials and that summary and reports completion
 * through the same terminal.
 */

import {
  type ChatGPTCredential,
  ChatGPTSignInRequiredError,
  clearChatGPTCredential,
  getChatGPTCredential,
  loadChatGPTCredential,
  saveChatGPTCredential,
  signInWithBrowser,
  signInWithDeviceCode,
} from "@jazz/adapters/llm/chatgpt";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { toError } from "@jazz/core/utils/errors";
import { Effect, Option } from "effect";

type SignInMethod = "browser" | "device" | "back";

function describePlan(plan: string | undefined): string {
  return plan ? ` (${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan)` : "";
}

/**
 * Walk the user through signing in and record the result: tokens in the keyring, the account id
 * and plan in config. Resolves to whether sign-in completed.
 */
export function signInToChatGPT(
  terminal: TerminalService,
  configService: AgentConfigService,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const method = yield* terminal.select<SignInMethod>("How do you want to sign in to ChatGPT?", {
      choices: [
        { name: "Open a browser on this machine", value: "browser" },
        {
          name: "Enter a code on another device",
          value: "device",
          description: "For SSH sessions and servers without a browser",
        },
        { name: "Back", value: "back" },
      ],
    });
    if (method === undefined || method === "back") {
      return false;
    }

    const announce = (message: string): void => {
      Effect.runFork(terminal.info(message));
    };

    const signIn: Promise<ChatGPTCredential> =
      method === "browser"
        ? signInWithBrowser((url) => {
            announce("Opening your browser to sign in to ChatGPT. If it does not open, visit:");
            announce(url);
          })
        : signInWithDeviceCode(({ userCode, verificationUri }) => {
            announce(`On any device, open ${verificationUri} and enter the code: ${userCode}`);
            announce("Waiting for approval...");
          });

    const outcome = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          const credential = await signIn;
          await saveChatGPTCredential(credential);
          return credential;
        },
        catch: toError,
      }),
    );

    if (outcome._tag === "Failure") {
      yield* terminal.error(`ChatGPT sign-in failed: ${outcome.failure.message}`);
      return false;
    }

    const credential = outcome.success;
    yield* configService.set("llm.chatgpt", {
      account_id: credential.accountId,
      ...(credential.plan !== undefined ? { plan: credential.plan } : {}),
    });
    yield* terminal.success(`Signed in to ChatGPT${describePlan(credential.plan)}.`);
    return true;
  });
}

function logDebug(message: string, meta?: Record<string, unknown>): Effect.Effect<void> {
  return Effect.gen(function* () {
    const logger = yield* Effect.serviceOption(LoggerServiceTag);
    if (Option.isSome(logger)) {
      yield* logger.value.debug(message, meta);
    }
  });
}

/**
 * Force a token refresh, even when the access token still looks fresh. A refresh token OpenAI
 * rejects can only be replaced by signing in, so that case moves straight to the sign-in prompt.
 * Resolves to whether a working credential is stored afterwards.
 */
export function refreshChatGPTSignIn(
  terminal: TerminalService,
  configService: AgentConfigService,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const outcome = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          const stored = await loadChatGPTCredential();
          if (stored === undefined) {
            throw new ChatGPTSignInRequiredError();
          }
          return getChatGPTCredential({ rejectedAccess: stored.access });
        },
        catch: (error) => error,
      }),
    );

    if (outcome._tag === "Success") {
      const credential = outcome.success;
      yield* logDebug("ChatGPT token refreshed", { elapsedMs: Date.now() - startedAt });
      yield* configService.set("llm.chatgpt", {
        account_id: credential.accountId,
        ...(credential.plan !== undefined ? { plan: credential.plan } : {}),
      });
      yield* terminal.success(`ChatGPT token refreshed${describePlan(credential.plan)}.`);
      return true;
    }

    const failure = outcome.failure;
    if (failure instanceof ChatGPTSignInRequiredError) {
      yield* logDebug("ChatGPT refresh token rejected; starting sign-in", {
        elapsedMs: Date.now() - startedAt,
      });
      yield* terminal.warn("Your ChatGPT sign-in has expired. Sign in again to keep using it.");
      return yield* signInToChatGPT(terminal, configService);
    }

    const message = toError(failure).message;
    yield* logDebug("ChatGPT token refresh failed", {
      elapsedMs: Date.now() - startedAt,
      error: message,
    });
    yield* terminal.error(`Could not refresh the ChatGPT token: ${message}`);
    return false;
  });
}

export function signOutOfChatGPT(
  terminal: TerminalService,
  configService: AgentConfigService,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* Effect.promise(() => clearChatGPTCredential());
    yield* configService.set("llm.chatgpt", undefined);
    yield* terminal.success("Signed out of ChatGPT.");
  });
}
