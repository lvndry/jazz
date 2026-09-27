import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatSandbox } from "./chat-sandbox";
import { buildJazzRunArgs, type JazzRunOptions, startJazzRun, stdinFrame } from "./jazz-run";

const sandbox: ChatSandbox = { home: "/data", uid: null, gid: null, isolated: false };

function options(overrides: Partial<JazzRunOptions> = {}): JazzRunOptions {
  return {
    jazzBinary: "jazz",
    surface: "test",
    agentId: "tg_1",
    sandbox,
    approvalPolicy: "low-risk",
    autoApproveTools: [],
    timezone: "UTC",
    runTimeoutMs: 60_000,
    conversation: { kind: "persistent", key: "tg_1-0" },
    prompt: "- buy milk --approval-policy=high-risk",
    ...overrides,
  };
}

describe("the jazz run command line", () => {
  test.each(["- buy milk", "--approval-policy=high-risk", "--agent=other"])(
    "never lets chat text %p reach option parsing",
    (prompt) => {
      const args = buildJazzRunArgs(options({ prompt }));
      expect(args).not.toContain(prompt);
      expect(args.filter((arg) => arg === "--approval-policy")).toHaveLength(1);
      expect(args.filter((arg) => arg === "--agent")).toHaveLength(1);
      expect(stdinFrame(options({ prompt }))).toEqual({ prompt });
    },
  );

  test("carries no message text, so it cannot be read with ps or parsed as a flag", () => {
    const args = buildJazzRunArgs(options());
    expect(args.join(" ")).not.toContain("buy milk");
    expect(args).toContain("--input-stdin");
    expect(args).toContain("--interactive-stdin");
  });

  test("keeps an incognito transcript off the command line too", () => {
    const history = [{ role: "user", content: "my secret" }];
    const args = buildJazzRunArgs(options({ conversation: { kind: "ephemeral", history } }));
    expect(args).toContain("--ephemeral");
    expect(args.join(" ")).not.toContain("my secret");
    expect(
      stdinFrame(options({ conversation: { kind: "ephemeral", history }, prompt: "hi" })),
    ).toEqual({ prompt: "hi", history });
  });

  test("sends no history for a persistent conversation or an empty incognito one", () => {
    expect(stdinFrame(options({ prompt: "hi" }))).toEqual({ prompt: "hi" });
    expect(
      stdinFrame(options({ prompt: "hi", conversation: { kind: "ephemeral", history: [] } })),
    ).toEqual({ prompt: "hi" });
  });
});

describe("a started run", () => {
  let directory: string;
  let fakeJazz: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "jazz-run-test-"));
    fakeJazz = join(directory, "fake-jazz.ts");
    // Echoes the first stdin line back as the answer, then the next line too, the
    // way a run would read an approval decision after its input frame.
    writeFileSync(
      fakeJazz,
      [
        `#!${process.execPath}`,
        "const reader = Bun.stdin.stream().getReader();",
        "let buffer = '';",
        "const lines: string[] = [];",
        "while (lines.length < 2) {",
        "  const { done, value } = await reader.read();",
        "  if (done) break;",
        "  buffer += new TextDecoder().decode(value);",
        "  let index = buffer.indexOf('\\n');",
        "  while (index >= 0) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1); index = buffer.indexOf('\\n'); }",
        "  if (lines.length === 1) console.error(JSON.stringify({ type: 'approval_required', toolCallId: 'call-1' }));",
        "}",
        "console.log(JSON.stringify({ ok: true, answer: JSON.stringify({ lines, argv: process.argv.slice(2) }), costUSD: 0 }));",
        "process.exit(0);",
      ].join("\n"),
    );
    chmodSync(fakeJazz, 0o755);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("writes the frame first and the approval after it", async () => {
    const run = startJazzRun(options({ jazzBinary: fakeJazz }), {
      onApprovalRequired: (event) => {
        void run.approve([{ toolCallId: event.toolCallId ?? "", approved: true }]);
      },
    });
    const envelope = await run.result;
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) {
      return;
    }
    const seen = JSON.parse(envelope.answer) as { lines: string[]; argv: string[] };
    expect(JSON.parse(seen.lines[0] ?? "")).toEqual({
      prompt: "- buy milk --approval-policy=high-risk",
    });
    expect(JSON.parse(seen.lines[1] ?? "")).toEqual({
      type: "approval_decision",
      toolCallId: "call-1",
      approved: true,
    });
    expect(seen.argv.join(" ")).not.toContain("buy milk");
  });
});
