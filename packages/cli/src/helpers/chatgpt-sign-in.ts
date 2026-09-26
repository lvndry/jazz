/**
 * Interactive ChatGPT subscription sign-in and sign-out, shared by `jazz config` and the agent
 * wizards when an agent picks the ChatGPT provider.
 */

import {
  type ChatGPTCredential,
  clearChatGPTCredential,
  saveChatGPTCredential,
  signInWithBrowser,
  signInWithDeviceCode,
} from "@jazz/adapters/llm/chatgpt";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { toError } from "@jazz/core/utils/errors";
import { Effect } from "effect";

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

    const outcome = yield* Effect.either(
      Effect.tryPromise({
        try: async () => {
          const credential = await signIn;
          await saveChatGPTCredential(credential);
          return credential;
        },
        catch: toError,
      }),
    );

    if (outcome._tag === "Left") {
      yield* terminal.error(`ChatGPT sign-in failed: ${outcome.left.message}`);
      return false;
    }

    const credential = outcome.right;
    yield* configService.set("llm.chatgpt", {
      account_id: credential.accountId,
      ...(credential.plan !== undefined ? { plan: credential.plan } : {}),
    });
    yield* terminal.success(`Signed in to ChatGPT${describePlan(credential.plan)}.`);
    return true;
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
