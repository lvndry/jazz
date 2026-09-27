import { AGENT_PROCESS_ENV } from "@jazz/core/utils/env";
import { describe, expect, it } from "bun:test";
import {
  answerRunFromChat,
  APPROVALS_HOME_ENV,
  parseOperatorIds,
  type RunAnswerRequest,
  type SpawnJazz,
} from "./run-answer";

interface Spawned {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

function recordingSpawn(stdout: string): { spawn: SpawnJazz; calls: Spawned[] } {
  const calls: Spawned[] = [];
  return {
    calls,
    spawn: async (argv, env) => {
      calls.push({ argv, env });
      return { exitCode: 0, stdout };
    },
  };
}

function request(overrides: Partial<RunAnswerRequest>): RunAnswerRequest {
  return {
    command: "approve",
    args: "run-123",
    senderId: "42",
    operatorIds: parseOperatorIds("42, 7"),
    operatorSettingName: "TELEGRAM_OPERATOR_IDS",
    jazzBinary: "jazz",
    env: { [APPROVALS_HOME_ENV]: "/home/me/.jazz", [AGENT_PROCESS_ENV]: "1", PATH: "/bin" },
    ...overrides,
  };
}

describe("answerRunFromChat", () => {
  it("refuses anyone who is not a listed operator, and runs nothing", async () => {
    const { spawn, calls } = recordingSpawn("{}");

    const reply = await answerRunFromChat(request({ senderId: "99", spawn }));

    expect(reply).toContain("TELEGRAM_OPERATOR_IDS");
    expect(reply).toContain("99");
    expect(calls).toHaveLength(0);
  });

  it("refuses everyone when no operator is listed", async () => {
    const { spawn, calls } = recordingSpawn("{}");

    await answerRunFromChat(request({ operatorIds: parseOperatorIds(""), spawn }));

    expect(calls).toHaveLength(0);
  });

  it("is off until the bridge names the Jazz home it answers for", async () => {
    const { spawn, calls } = recordingSpawn("{}");

    const reply = await answerRunFromChat(request({ env: {}, spawn }));

    expect(reply).toContain(APPROVALS_HOME_ENV);
    expect(calls).toHaveLength(0);
  });

  it("keeps anything flag-shaped out of the command line", async () => {
    const { spawn, calls } = recordingSpawn("{}");

    const reply = await answerRunFromChat(request({ args: "--approval-policy=high-risk", spawn }));

    expect(reply).toStartWith("Usage: /approve");
    expect(calls).toHaveLength(0);
  });

  it("approves through the local CLI as the operator, against the approvals home", async () => {
    const { spawn, calls } = recordingSpawn('{"ok":true,"runId":"run-123","answer":"Done."}\n');

    const reply = await answerRunFromChat(request({ spawn }));

    expect(calls[0]?.argv).toEqual(["jazz", "runs", "approve", "run-123", "--json"]);
    expect(calls[0]?.env["JAZZ_HOME"]).toBe("/home/me/.jazz");
    expect(calls[0]?.env[AGENT_PROCESS_ENV]).toBeUndefined();
    expect(reply).toContain("Approved run run-123");
    expect(reply).toContain("Done.");
  });

  it("denies with the reason as a note, and relays a refusal", async () => {
    const { spawn, calls } = recordingSpawn('{"ok":false,"error":"No run with id \\"run-123\\"."}');

    const reply = await answerRunFromChat(
      request({ command: "deny", args: "run-123 not on a Friday", spawn }),
    );

    expect(calls[0]?.argv).toEqual([
      "jazz",
      "runs",
      "reject",
      "run-123",
      "--json",
      "--note",
      "not on a Friday",
    ]);
    expect(reply).toContain("was not answered");
  });
});
