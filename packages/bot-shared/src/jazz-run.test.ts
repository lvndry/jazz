import { describe, expect, it } from "bun:test";
import { buildJazzRunArgs, type JazzRunOptions } from "./jazz-run";

function runOptions(prompt: string): JazzRunOptions {
  return {
    jazzBinary: "jazz",
    agentId: "agent-1",
    sandbox: { home: "/data/agent-1", uid: null, gid: null, isolated: false },
    approvalPolicy: "false",
    autoApproveTools: [],
    timezone: "UTC",
    runTimeoutMs: 300_000,
    conversation: { kind: "persistent", key: "chat-1" },
    prompt,
  };
}

describe("buildJazzRunArgs", () => {
  it.each(["- buy milk", "--approval-policy=high-risk", "--agent=other"])(
    "ends option parsing before the chat text %p",
    (prompt) => {
      const args = buildJazzRunArgs(runOptions(prompt));
      expect(args.slice(-2)).toEqual(["--", prompt]);
      expect(args.filter((arg) => arg === "--approval-policy")).toHaveLength(1);
    },
  );
});
