import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { RunParkRequested } from "@/core/agent/run/park-signal";
import { OUTBOX_FILE_KIND, outboxDirectory, outboxFilePath } from "@/core/notify/outbox";
import type { AppConfig } from "@/core/types/config";
import { readStateFile } from "@/core/utils/state-file";
import { SPEND_LEDGER_ENV, SpendCeilingReachedError } from "./ceilings";
import { readSpend, recordSpend } from "./ledger";
import { guardRunStart, type RunAccountingInput, settleRunAccounting } from "./run-accounting";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  delete process.env[SPEND_LEDGER_ENV];
});

function temporaryHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "jazz-run-accounting-"));
  homes.push(home);
  return home;
}

const CHANNELS = { phone: { type: "telegram", chatId: "1" } } as const;

function input(home: string, overrides: Partial<RunAccountingInput> = {}): RunAccountingInput {
  return {
    agentId: "agent",
    origin: { source: "workflow", name: "brief" },
    internal: false,
    appConfig: {
      spend: { dayUSD: 1 },
      notifications: { channels: CHANNELS },
    } as unknown as AppConfig,
    freeLocalModel: false,
    home,
    ...overrides,
  };
}

function queued(home: string) {
  return Effect.runPromise(
    readStateFile(outboxFilePath(outboxDirectory(home), "phone"), OUTBOX_FILE_KIND, {
      onCorrupt: "fail",
    }),
  ).then((items) => items ?? []);
}

function spendOne(home: string, costUSD: number) {
  return Effect.runPromise(
    recordSpend(
      { agentId: "agent", source: "workflow", costUSD, costKnown: true, tokens: 1 },
      home,
    ),
  );
}

describe("guardRunStart", () => {
  it("refuses an unattended run once a ceiling is reached, and notifies once per window", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);

    const first = await Effect.runPromise(Effect.either(guardRunStart(input(home))));
    const second = await Effect.runPromise(Effect.either(guardRunStart(input(home))));

    expect(first._tag === "Left" && first.left instanceof SpendCeilingReachedError).toBe(true);
    expect(second._tag).toBe("Left");
    const items = await queued(home);
    expect(items.map((item) => item.event.kind)).toEqual(["spend-ceiling"]);
  });

  it("lets chat through with the check, so the chat can warn", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);

    const check = await Effect.runPromise(
      guardRunStart(input(home, { origin: { source: "chat" } })),
    );

    expect(check.kind).toBe("reached");
    expect(await queued(home)).toEqual([]);
  });

  it("skips the check for a run whose parent records it", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);
    process.env[SPEND_LEDGER_ENV] = "parent";

    const check = await Effect.runPromise(guardRunStart(input(home)));

    expect(check.kind).toBe("clear");
  });
});

describe("settleRunAccounting", () => {
  const spend = { costUSD: 0.2, costIncomplete: false, totalTokens: 40 };

  it("records a failed run's cost and tells the channel it failed", async () => {
    const home = temporaryHome();

    await Effect.runPromise(
      settleRunAccounting(input(home), spend, Exit.fail(new Error("provider down")), "run-1"),
    );

    const ledger = await Effect.runPromise(readSpend(Date.now(), home));
    expect(ledger.today.total).toMatchObject({ costUSD: 0.2, runs: 1, tokens: 40 });
    const items = await queued(home);
    expect(items[0]?.event).toMatchObject({
      kind: "unattended-failed",
      source: "workflow",
      name: "brief",
      error: "provider down",
    });
  });

  it("asks for an approval when an unattended run parks", async () => {
    const home = temporaryHome();
    const park = new RunParkRequested({
      pending: {
        kind: "tool-approval",
        request: {
          toolCallId: "call-1",
          toolName: "execute_command",
          message: "rm -rf build",
          executeToolName: "execute_command",
          executeArgs: {},
        },
      },
      runId: "run-2",
      expiresAt: "2026-09-28T00:00:00.000Z",
    });

    await Effect.runPromise(settleRunAccounting(input(home), spend, Exit.fail(park), "run-2"));

    const items = await queued(home);
    expect(items[0]?.event).toMatchObject({
      kind: "approval-needed",
      runId: "run-2",
      pending: "tool-approval",
      request: "execute_command: rm -rf build",
    });
  });

  it("does not report a chat turn that failed: the person saw it", async () => {
    const home = temporaryHome();

    await Effect.runPromise(
      settleRunAccounting(
        input(home, { origin: { source: "chat" } }),
        spend,
        Exit.failCause(Cause.fail(new Error("nope"))),
        "run-3",
      ),
    );

    expect(await queued(home)).toEqual([]);
  });

  it("counts a run that never reached the model as free, not unpriced", async () => {
    const home = temporaryHome();

    await Effect.runPromise(
      settleRunAccounting(
        input(home, { origin: { source: "chat" } }),
        { costUSD: undefined, costIncomplete: false, totalTokens: 0 },
        Exit.succeed(undefined),
        "run-4",
      ),
    );

    const ledger = await Effect.runPromise(readSpend(Date.now(), home));
    expect(ledger.today.total.unpricedRuns).toBe(0);
  });
});
