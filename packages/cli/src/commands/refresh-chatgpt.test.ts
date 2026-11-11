import { EventEmitter } from "node:events";
import type { ChatGPTAccess, GetChatGPTAccessOptions } from "@jazz/adapters/llm/chatgpt";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  ensureChatGPTAccessValidFor,
  parseMinValidMinutes,
  type RefreshChatGPTDependencies,
  runRefreshChatGPTCommand,
} from "./refresh-chatgpt";

const EXPIRES = Date.parse("2026-11-21T12:00:00Z");

function access(token: string): ChatGPTAccess {
  return { access: token, expires: EXPIRES, accountId: "account-1" };
}

/** Records every step in order, so a test can tell what ran before what. */
function recordingDependencies(overrides?: Partial<RefreshChatGPTDependencies>): {
  readonly dependencies: RefreshChatGPTDependencies;
  readonly steps: string[];
} {
  const steps: string[] = [];
  let calls = 0;
  return {
    steps,
    dependencies: {
      getCredential: (options?: GetChatGPTAccessOptions) => {
        calls += 1;
        steps.push(`get ${options?.minValidityMs ?? "default"}`);
        return Promise.resolve(access(`secret-access-${calls}`));
      },
      verify: () => {
        steps.push("verify");
        return Promise.resolve();
      },
      ...overrides,
    },
  };
}

describe("ensureChatGPTAccessValidFor", () => {
  it("renews for the requested validity, checks the token, and returns the token now in force", async () => {
    const { dependencies, steps } = recordingDependencies();

    const result = await ensureChatGPTAccessValidFor(86_400_000, dependencies);

    expect(steps).toEqual(["get 86400000", "verify", "get 86400000"]);
    expect(result.access).toBe("secret-access-2");
  });

  it("fails when the check fails", async () => {
    const { dependencies } = recordingDependencies({
      verify: () => Promise.reject(new Error("Failed to list ChatGPT models: 500")),
    });

    await expect(ensureChatGPTAccessValidFor(0, dependencies)).rejects.toThrow("500");
  });
});

describe("parseMinValidMinutes", () => {
  it("accepts whole minutes only", () => {
    expect(parseMinValidMinutes("1440")).toBe(1440);
    expect(parseMinValidMinutes(" 0 ")).toBe(0);
    expect(parseMinValidMinutes("-5")).toBeUndefined();
    expect(parseMinValidMinutes("1.5")).toBeUndefined();
    expect(parseMinValidMinutes("1d")).toBeUndefined();
    expect(parseMinValidMinutes("")).toBeUndefined();
  });
});

describe("runRefreshChatGPTCommand", () => {
  let stdout: string[];
  let stderr: string[];
  let previousExitCode: typeof process.exitCode;
  let restoreOutput: (() => void)[] = [];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
      },
    );
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      },
    );
    restoreOutput = [() => stdoutSpy.mockRestore(), () => stderrSpy.mockRestore()];
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    for (const restore of restoreOutput) {
      restore();
    }
  });

  it("prints the expiry and never the token", async () => {
    const { dependencies } = recordingDependencies();

    await runRefreshChatGPTCommand("1440", dependencies);

    expect(stdout.join("")).toBe("ChatGPT access token valid until 2026-11-21T12:00:00.000Z.\n");
    expect([...stdout, ...stderr].join("")).not.toContain("secret-access");
    expect(process.exitCode).toBe(0);
  });

  it("exits non-zero with the cause when the credential cannot be renewed", async () => {
    const { dependencies } = recordingDependencies({
      getCredential: () => Promise.reject(new Error("ChatGPT token refresh failed (400)")),
    });

    await runRefreshChatGPTCommand("1440", dependencies);

    expect(stderr.join("")).toContain("ChatGPT token refresh failed (400)");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a malformed duration before touching the credential", async () => {
    const { dependencies, steps } = recordingDependencies();

    await runRefreshChatGPTCommand("a day", dependencies);

    expect(steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("finishes a refresh in flight before honouring SIGTERM", async () => {
    let finishVerify: () => void = () => undefined;
    const verifying = new Promise<void>((resolve) => {
      finishVerify = resolve;
    });
    let verifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      verifyStarted = resolve;
    });
    const signals = new EventEmitter();
    const { dependencies } = recordingDependencies({
      verify: () => {
        verifyStarted();
        return verifying;
      },
    });

    const command = runRefreshChatGPTCommand("1440", dependencies, signals);
    await started;
    signals.emit("SIGTERM", "SIGTERM");
    finishVerify();
    await command;

    expect(stdout.join("")).toContain("valid until");
    expect(stderr.join("")).toContain("finishing the ChatGPT token check first");
    expect(process.exitCode).toBe(143);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
