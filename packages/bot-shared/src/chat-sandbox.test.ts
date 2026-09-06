import { describe, expect, test } from "bun:test";
import {
  type ChatSandbox,
  chatHome,
  chatIsolationEnabled,
  ensureChatSandbox,
  listChatSandboxes,
  resetChatIsolationDecision,
  sandboxCommand,
  sandboxEnv,
} from "./chat-sandbox";

function withIsolationFlag<T>(value: string | undefined, body: () => T): T {
  const previous = process.env["JAZZ_BOT_CHAT_ISOLATION"];
  if (value === undefined) delete process.env["JAZZ_BOT_CHAT_ISOLATION"];
  else process.env["JAZZ_BOT_CHAT_ISOLATION"] = value;
  resetChatIsolationDecision();
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env["JAZZ_BOT_CHAT_ISOLATION"];
    else process.env["JAZZ_BOT_CHAT_ISOLATION"] = previous;
    resetChatIsolationDecision();
  }
}

const isolated: ChatSandbox = {
  home: "/data/chats/tg_42",
  uid: 70_000,
  gid: 3000,
  isolated: true,
};

describe("isolation is opt-out and needs privilege", () => {
  test("an explicit 0 turns it off", () => {
    withIsolationFlag("0", () => {
      expect(chatIsolationEnabled()).toBe(false);
    });
  });

  test("a non-root process cannot sandbox, whatever the flag says", () => {
    if (process.getuid?.() === 0) return;
    withIsolationFlag("1", () => {
      expect(chatIsolationEnabled()).toBe(false);
    });
  });
});

describe("without isolation nothing moves", () => {
  test("a chat's home is the shared data directory", () => {
    withIsolationFlag("0", () => {
      expect(chatHome("/data", "tg_42")).toBe("/data");
    });
  });

  test("ensureChatSandbox touches no filesystem and claims no uid", () => {
    withIsolationFlag("0", () => {
      const sandbox = ensureChatSandbox("/definitely/not/a/real/path", "tg_42");
      expect(sandbox).toEqual({
        home: "/definitely/not/a/real/path",
        uid: null,
        gid: null,
        isolated: false,
      });
    });
  });

  test("there are no sandboxes to list", () => {
    withIsolationFlag("0", () => {
      expect(listChatSandboxes("/data")).toEqual([]);
    });
  });

  test("the command and environment are passed straight through", () => {
    withIsolationFlag("0", () => {
      const sandbox = ensureChatSandbox("/data", "tg_42");
      expect(sandboxCommand(sandbox, ["jazz", "run"])).toEqual(["jazz", "run"]);
      expect(sandboxEnv(sandbox, { JAZZ_HOME: "/data" })).toEqual({ JAZZ_HOME: "/data" });
    });
  });
});

describe("a sandboxed run", () => {
  test("drops to the chat's uid and takes no supplementary groups with it", () => {
    expect(sandboxCommand(isolated, ["jazz", "run", "--agent", "tg_42"])).toEqual([
      "setpriv",
      "--reuid",
      "70000",
      "--regid",
      "70000",
      "--clear-groups",
      "--",
      "jazz",
      "run",
      "--agent",
      "tg_42",
    ]);
  });

  test("keeps the chat's gid off the operator group, so group bits stay one-way", () => {
    const command = sandboxCommand(isolated, ["jazz"]);
    expect(command[command.indexOf("--regid") + 1]).not.toBe(String(isolated.gid));
  });

  test("moves every path that defaults to $HOME or $JAZZ_HOME inside the sandbox", () => {
    const environment = sandboxEnv(isolated, { JAZZ_HOME: "/data", OPENAI_API_KEY: "sk-test" });
    expect(environment["JAZZ_HOME"]).toBe("/data/chats/tg_42");
    expect(environment["HOME"]).toBe("/data/chats/tg_42");
    for (const key of [
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "GNUPGHOME",
      "PASSWORD_STORE_DIR",
      "TMPDIR",
    ]) {
      expect(environment[key]?.startsWith("/data/chats/tg_42/")).toBe(true);
    }
  });

  test("still carries the provider keys the run needs", () => {
    expect(sandboxEnv(isolated, { OPENAI_API_KEY: "sk-test" })["OPENAI_API_KEY"]).toBe("sk-test");
  });
});
