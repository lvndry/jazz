import * as chatgpt from "@jazz/adapters/llm/chatgpt";
import type { ChatGPTCredential } from "@jazz/adapters/llm/chatgpt";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Effect } from "effect";
import { refreshChatGPTSignIn } from "./chatgpt-sign-in";

const storedCredential = {
  access: "access-old",
  refresh: "refresh-old",
  expires: Date.now() + 60 * 60 * 1000,
  accountId: "account-1",
  plan: "plus",
} as ChatGPTCredential;

let writes: { key: string; value: unknown }[] = [];
const configService = {
  set: mock((key: string, value: unknown) => {
    writes.push({ key, value });
    return Effect.void;
  }),
} as unknown as AgentConfigService;

const terminal = {
  isInteractive: true,
  info: mock(() => Effect.void),
  success: mock(() => Effect.void),
  warn: mock(() => Effect.void),
  error: mock(() => Effect.void),
  select: mock(() => Effect.succeed<string | undefined>("back")),
} as unknown as TerminalService;

const spies: { mockRestore: () => void }[] = [];
let clearCalls = 0;

function stubCredentials(get: () => Promise<ChatGPTCredential>): void {
  spies.push(
    spyOn(chatgpt, "loadChatGPTCredential").mockImplementation(async () => storedCredential),
    spyOn(chatgpt, "getChatGPTCredential").mockImplementation(get),
    spyOn(chatgpt, "clearChatGPTCredential").mockImplementation(async () => {
      clearCalls += 1;
    }),
  );
}

function refresh(): Promise<boolean> {
  return Effect.runPromise(refreshChatGPTSignIn(terminal, configService));
}

beforeEach(() => {
  writes = [];
  clearCalls = 0;
  for (const method of ["info", "success", "warn", "error", "select"] as const) {
    (terminal[method] as ReturnType<typeof mock>).mockClear();
  }
});

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

describe("refreshChatGPTSignIn", () => {
  it("forces a refresh past the stored access token and records the account", async () => {
    stubCredentials(async () => ({ ...storedCredential, access: "access-new", plan: "pro" }));

    expect(await refresh()).toBe(true);
    expect(chatgpt.getChatGPTCredential).toHaveBeenCalledWith({ rejectedAccess: "access-old" });
    expect(writes).toEqual([
      { key: "llm.chatgpt", value: { account_id: "account-1", plan: "pro" } },
    ]);
    expect(terminal.success).toHaveBeenCalledWith("ChatGPT token refreshed (Pro plan).");
  });

  it("removes a rejected sign-in before prompting, so cancelling leaves Jazz signed out", async () => {
    stubCredentials(async () => {
      throw new chatgpt.ChatGPTSignInRequiredError("ChatGPT token refresh failed (401)");
    });

    expect(await refresh()).toBe(false);
    expect(clearCalls).toBe(1);
    expect(writes).toEqual([{ key: "llm.chatgpt", value: undefined }]);
    expect(terminal.select).toHaveBeenCalledWith(
      "How do you want to sign in to ChatGPT?",
      expect.anything(),
    );
  });

  it("keeps the sign-in through a transient failure and reports it", async () => {
    stubCredentials(async () => {
      throw new Error("fetch failed");
    });

    expect(await refresh()).toBe(false);
    expect(clearCalls).toBe(0);
    expect(writes).toEqual([]);
    expect(terminal.select).not.toHaveBeenCalled();
    expect(terminal.error).toHaveBeenCalledWith(
      "Could not refresh the ChatGPT token: fetch failed",
    );
  });
});
