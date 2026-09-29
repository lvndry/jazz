import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { RunParkRequested } from "@/core/agent/run/park-signal";
import { daemonStatePath } from "@/core/daemon/daemon-state";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { OUTBOX_FILE_KIND, outboxDirectory, outboxFilePath } from "@/core/notify/outbox";
import type { AppConfig } from "@/core/types/config";
import { readStateFile } from "@/core/utils/state-file";
import { SPEND_LEDGER_ENV, SpendCapReachedError } from "./caps";
import { readSpend, recordSpend } from "./ledger";
import {
  guardRunStart,
  isUnattendedRun,
  releaseRunReservation,
  type RunAccountingInput,
  settleRunAccounting,
} from "./run-accounting";

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

const TARGETS = [{ name: "phone", kind: "telegram", chatId: "1" }] as const;

function input(home: string, overrides: Partial<RunAccountingInput> = {}): RunAccountingInput {
  return {
    agentId: "agent",
    origin: { source: "workflow", name: "brief" },
    internal: false,
    unattended: true,
    appConfig: {
      daemon: { dailyCostUSD: 1 },
      notify: { targets: TARGETS },
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
      {
        agentId: "agent",
        source: "workflow",
        costUSD,
        costKnown: true,
        tokens: 1,
        unattended: true,
      },
      home,
    ),
  );
}

describe("isUnattendedRun", () => {
  it("marks a run nobody could be asked in as unattended, and a chat's run as attended", () => {
    expect(isUnattendedRun("workflow", false)).toBe(true);
    expect(isUnattendedRun("chat", true)).toBe(false);
    expect(isUnattendedRun("bot", true)).toBe(false);
  });

  it("counts `jazz run` as unattended even when its events consumer can answer prompts", () => {
    expect(isUnattendedRun("run", true)).toBe(true);
    expect(isUnattendedRun("run", false)).toBe(true);
  });
});

describe("guardRunStart", () => {
  it("refuses an unattended run once a cap is reached, and notifies once per window", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);

    const first = await Effect.runPromise(Effect.either(guardRunStart(input(home))));
    const second = await Effect.runPromise(Effect.either(guardRunStart(input(home))));

    expect(first._tag === "Left" && first.left instanceof SpendCapReachedError).toBe(true);
    expect(second._tag).toBe("Left");
    const items = await queued(home);
    expect(items.map((item) => item.event.kind)).toEqual(["spend-cap"]);
  });

  it("lets an attended run through with the check, so the chat can warn", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);

    const check = await Effect.runPromise(
      guardRunStart(input(home, { origin: { source: "chat" }, unattended: false })),
    );

    expect(check.kind).toBe("reached");
    expect(await queued(home)).toEqual([]);
  });

  it("honors `jazz daemon resume` lifting the machine daily cap for today", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    writeFileSync(
      daemonStatePath(home),
      JSON.stringify({ capLiftedUntil: tomorrow, notified: {} }),
    );

    const check = await Effect.runPromise(guardRunStart(input(home)));

    expect(check.kind).toBe("clear");
  });

  it("never refuses a run answering a parked one", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);

    const check = await Effect.runPromise(
      guardRunStart(input(home, { origin: { source: "resume" } })),
    );

    expect(check.kind).toBe("clear");
  });

  it("holds a reservation for a run that passes, so a second run started at once is refused", async () => {
    const home = temporaryHome();
    await spendOne(home, 0.6);
    const first = input(home, { reservationId: "run-a" });

    const firstCheck = await Effect.runPromise(guardRunStart(first));
    const second = await Effect.runPromise(
      Effect.either(guardRunStart(input(home, { reservationId: "run-b" }))),
    );
    await Effect.runPromise(releaseRunReservation(first));
    const third = await Effect.runPromise(guardRunStart(input(home, { reservationId: "run-c" })));

    expect(firstCheck.kind).toBe("clear");
    expect(second._tag === "Left" && second.left instanceof SpendCapReachedError).toBe(true);
    expect(third.kind).toBe("clear");
  });

  it("applies an agent cap keyed by the agent's name, looking the name up by id", async () => {
    const home = temporaryHome();
    await spendOne(home, 1);
    const agents = {
      listAgents: () => Effect.succeed([{ id: "agent", name: "inbox" }]),
    } as unknown as AgentService;
    const capped = input(home, {
      appConfig: { daemon: { agents: { inbox: { dailyCostUSD: 1 } } } } as unknown as AppConfig,
    });

    const result = await Effect.runPromise(
      Effect.either(guardRunStart(capped)).pipe(
        Effect.provide(Layer.succeed(AgentServiceTag, agents)),
      ),
    );

    expect(result._tag === "Left" && result.left.message).toContain('agent "inbox"');
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

  it("records a failed run's cost and tells the targets it failed", async () => {
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

  it("announces a parked run as waiting, with the key the daemon's tick uses", async () => {
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
      kind: "waiting",
      item: {
        key: "run:run-2:call-1",
        kind: "approval",
        runId: "run-2",
        title: "Workflow brief wants to use execute_command",
        detail: "rm -rf build",
      },
    });
  });

  it("does not report a chat turn that failed: the person saw it", async () => {
    const home = temporaryHome();

    await Effect.runPromise(
      settleRunAccounting(
        input(home, { origin: { source: "chat" }, unattended: false }),
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
    expect(ledger.today.unattended.runs).toBe(1);
  });
});
