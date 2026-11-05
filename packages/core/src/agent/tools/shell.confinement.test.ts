import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { getConfinementStatus, type ConfinementStatus } from "@/core/sandbox/backend";
import { shellEscalationLedger } from "@/core/sandbox/escalation";
import { createSanitizedEnv } from "@/core/utils/env";
import { createShellCommandTools, runShellCommand } from "./shell";
import { FileSystemContextServiceTag, type FileSystemContextService } from "../../interfaces/fs";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import type { ToolExecutionContext } from "../../types";

const hostStatus = getConfinementStatus();
const itConfined = hostStatus.level === "full" ? it : it.skip;

const unavailable: ConfinementStatus = {
  level: "none",
  backend: "none",
  reason: "bubblewrap (`bwrap`) is not installed",
  remedy: "Install bubblewrap or set `shell.confinement` to `off`.",
};

let base: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jazz-shell-confinement-")));
  workspace = path.join(base, "workspace");
  mkdirSync(workspace);
  outside = mkdtempSync(path.join(process.cwd(), ".confinement-outside-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function testLayer(logs: string[]) {
  const fileSystemContext: FileSystemContextService = {
    getCwd: () => Effect.succeed(workspace),
    setCwd: () => Effect.void,
    resolvePath: (_key, target) =>
      Effect.gen(function* () {
        yield* FileSystem.FileSystem;
        return path.isAbsolute(target) ? target : path.join(workspace, target);
      }),
    findDirectory: () => Effect.succeed({ results: [] as readonly string[] }),
    resolvePathForMkdir: (_key, target) =>
      Effect.succeed(path.isAbsolute(target) ? target : path.join(workspace, target)),
    escapePath: (target) => target,
  };
  const logger: LoggerService = {
    debug: (message) => Effect.sync(() => void logs.push(message)),
    info: (message) => Effect.sync(() => void logs.push(message)),
    warn: (message) => Effect.sync(() => void logs.push(message)),
    error: () => Effect.void,
    writeToFile: () => Effect.void,
    logToolCall: () => Effect.void,
    setLogGroup: () => Effect.void,
    clearLogGroup: () => Effect.void,
    pushLogGroup: () => Effect.void,
    popLogGroup: () => Effect.void,
  };
  return Layer.mergeAll(
    Layer.provide(
      Layer.succeed(FileSystemContextServiceTag, fileSystemContext),
      NodeFileSystem.layer,
    ),
    NodeFileSystem.layer,
    Layer.succeed(LoggerServiceTag, logger),
  );
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    agentId: "agent",
    conversationId: "conversation",
    runId: `run-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

const shellTools = createShellCommandTools();

describe("runShellCommand confinement", () => {
  it("fails closed without running the command when confinement is unavailable", async () => {
    const marker = path.join(workspace, "ran.txt");
    const error = await Effect.runPromise(
      Effect.flip(
        runShellCommand({
          command: `touch "${marker}"`,
          workingDir: workspace,
          timeoutMs: 5_000,
          env: createSanitizedEnv({}, []),
          confinement: { policy: { roots: [workspace] }, status: unavailable },
        }),
      ),
    );
    expect(error.message).toContain("not installed");
    expect(error.message).toContain("The command was not run.");
    expect(existsSync(marker)).toBe(false);
  });

  itConfined("fences writes to the policy roots through a real spawn", async () => {
    const result = await Effect.runPromise(
      runShellCommand({
        command: `echo in > "${workspace}/in.txt"; echo out > "${outside}/out.txt"`,
        workingDir: workspace,
        timeoutMs: 10_000,
        env: createSanitizedEnv({}, []),
        confinement: { policy: { roots: [workspace] } },
      }),
    );
    expect(existsSync(path.join(workspace, "in.txt"))).toBe(true);
    expect(existsSync(path.join(outside, "out.txt"))).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  itConfined("still stops a confined command at its timeout and kills the group", async () => {
    const startedAt = Date.now();
    const result = await Effect.runPromise(
      runShellCommand({
        command: "sleep 30",
        workingDir: workspace,
        timeoutMs: 500,
        env: createSanitizedEnv({}, []),
        confinement: { policy: { roots: [workspace] } },
      }),
    );
    expect(result.exitCode).toBe(124);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("execute_command under confinement", () => {
  itConfined("reports a denial, offers one escalation, and refuses a second", async () => {
    const logs: string[] = [];
    const runContext = context({ shellConfinement: "on", parkWhenUnattended: true });
    const target = path.join(outside, "denied.txt");
    const command = `echo x > "${target}"`;
    const run = (args: Record<string, unknown>) =>
      Effect.runPromise(
        shellTools.execute.execute(args, runContext).pipe(Effect.provide(testLayer(logs))),
      );

    const denied = await run({ command, description: "Write outside the workspace." });
    expect(existsSync(target)).toBe(false);
    const confinement = (
      denied.result as { confinement?: { deniedPath: string; guidance: string } }
    ).confinement;
    expect(confinement?.deniedPath).toBe(target);
    expect(shellEscalationLedger.peek(runContext.runId ?? "", command)).toBe(target);
    expect(logs).toContain("Command hit a write-confinement denial");

    const escalated = await run({
      command,
      description: "Write outside the workspace.",
      escalate: "The task is to produce a file there.",
    });
    expect(escalated.success).toBe(true);
    expect(existsSync(target)).toBe(true);

    const again = await run({
      command,
      description: "Write outside the workspace.",
      escalate: "Try again.",
    });
    expect(again.success).toBe(false);
    expect(again.error).toContain("escalate");
  });

  itConfined("offers no escalation when nobody can approve it", async () => {
    const runContext = context({ shellConfinement: "on" });
    const command = `echo x > "${path.join(outside, "nobody.txt")}"`;
    const result = await Effect.runPromise(
      shellTools.execute
        .execute({ command, description: "Write outside." }, runContext)
        .pipe(Effect.provide(testLayer([]))),
    );
    const guidance = (result.result as { confinement?: { guidance: string } }).confinement
      ?.guidance;
    expect(guidance).toContain("nobody is available to approve");
    expect(shellEscalationLedger.peek(runContext.runId ?? "", command)).toBeUndefined();
  });

  it("refuses escalate for a command that was never denied", async () => {
    const result = await Effect.runPromise(
      shellTools.execute
        .execute(
          { command: "echo hi", description: "Say hi.", escalate: "Because." },
          context({ shellConfinement: "on" }),
        )
        .pipe(Effect.provide(testLayer([]))),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("escalate");
  });

  it("asks a person for an escalated retry whatever the approval policy", async () => {
    const runContext = context({ shellConfinement: "on" });
    const command = "echo escalated";
    shellEscalationLedger.offer(runContext.runId ?? "", command, "/somewhere/else");
    const result = await Effect.runPromise(
      shellTools.approval
        .execute(
          { command, description: "Retry.", escalate: "Needs that path." },
          { ...runContext, getAutoApprovePolicy: () => true },
        )
        .pipe(Effect.provide(testLayer([]))),
    );
    const message = (result.result as { message?: string }).message ?? "";
    expect(message).toContain("WITHOUT write confinement");
    expect(message).toContain("/somewhere/else");
    expect(message).toContain("Needs that path.");
    expect((result.result as { alwaysAsk?: boolean }).alwaysAsk).toBe(true);
  });

  it("runs unconfined and untouched when confinement is off", async () => {
    const target = path.join(outside, "free.txt");
    const result = await Effect.runPromise(
      shellTools.execute
        .execute(
          { command: `echo free > "${target}"`, description: "Write freely." },
          context({ shellConfinement: "off" }),
        )
        .pipe(Effect.provide(testLayer([]))),
    );
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(result.result).not.toHaveProperty("confinement");
  });
});
