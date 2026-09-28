import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { type NotificationService, NotificationServiceTag } from "@/core/interfaces/notification";
import type { NotifyTarget } from "@/core/types/notify";
import { readStateFile, writeStateFile } from "@/core/utils/state-file";
import type { NotifyEvent } from "./events";
import {
  enqueueNotification,
  MAX_OUTBOX_ITEMS_PER_TARGET,
  NotificationQueueError,
  type OutboxItem,
  OUTBOX_FILE_KIND,
  outboxDirectory,
  outboxFilePath,
  notifyTargets,
  routeNotification,
} from "./outbox";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "jazz-notify-outbox-"));
  homes.push(home);
  return home;
}

const targets: readonly NotifyTarget[] = [
  { name: "phone", kind: "telegram", chatId: "1" },
  { name: "desk", kind: "desktop" },
  { name: "ops", kind: "webhook", url: "https://example.com/hook", events: ["unattended-failed"] },
];

const reminder: NotifyEvent = { kind: "reminder", agentId: "a", text: "call mom", fireAt: 0 };
const failure: NotifyEvent = { kind: "unattended-failed", source: "workflow", error: "boom" };
const result: NotifyEvent = {
  kind: "workflow-result",
  workflow: "brief",
  agentId: "a",
  answer: "sunny",
};

describe("routeNotification", () => {
  it("sends to every target subscribed to the event", () => {
    expect(routeNotification(targets, failure).targets).toEqual(["desk", "ops", "phone"]);
    expect(routeNotification(targets, reminder).targets).toEqual(["desk", "phone"]);
  });

  it("sends a workflow result only where deliver names, and reports unknown names", () => {
    expect(routeNotification(targets, result)).toEqual({ targets: [], missing: [] });
    expect(routeNotification(targets, result, { targets: ["phone", "nope"] })).toEqual({
      targets: ["phone"],
      missing: ["nope"],
    });
  });

  it("leaves out target kinds the caller already tried", () => {
    expect(routeNotification(targets, reminder, { excludeKinds: ["desktop"] }).targets).toEqual([
      "phone",
    ]);
  });
});

describe("notifyTargets", () => {
  it("is one desktop target while notify.targets is unset, and none when notifications are off", () => {
    expect(notifyTargets({}).map((target) => target.kind)).toEqual(["desktop"]);
    expect(notifyTargets({ notifications: { enabled: false } })).toEqual([]);
    expect(notifyTargets({ notify: { targets: [] } })).toEqual([]);
    expect(
      notifyTargets({ notify: { targets }, notifications: { enabled: false } }).map(
        (target) => target.name,
      ),
    ).toEqual(["phone", "ops"]);
  });
});

describe("enqueueNotification", () => {
  it("writes nothing when there is no target", async () => {
    const home = temporaryHome();

    const outcome = await Effect.runPromise(enqueueNotification([], failure, { home }));

    expect(outcome.queued).toEqual([]);
  });

  it("queues one item per target, due now", async () => {
    const home = temporaryHome();

    await Effect.runPromise(enqueueNotification(targets, failure, { home, now: 1_000 }));

    const items = await Effect.runPromise(
      readStateFile(outboxFilePath(outboxDirectory(home), "ops"), OUTBOX_FILE_KIND, {
        onCorrupt: "fail",
      }),
    );
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({ fireAt: 1_000, event: failure });
  });

  it("sends a deduplicated event once", async () => {
    const home = temporaryHome();

    const first = await Effect.runPromise(
      enqueueNotification(targets, failure, { home, dedupeKey: "k" }),
    );
    const second = await Effect.runPromise(
      enqueueNotification(targets, failure, { home, dedupeKey: "k" }),
    );

    expect(first.queued.length).toBeGreaterThan(0);
    expect(second).toMatchObject({ queued: [], duplicate: true });
  });

  it("spends a dedupe key only on the targets the event went onto", async () => {
    const home = temporaryHome();
    const baseDirectory = outboxDirectory(home);
    const full: OutboxItem[] = Array.from({ length: MAX_OUTBOX_ITEMS_PER_TARGET }, (_, index) => ({
      id: `old-${index}`,
      fireAt: index,
      event: failure,
    }));
    await Effect.runPromise(
      writeStateFile(outboxFilePath(baseDirectory, "phone"), OUTBOX_FILE_KIND, full),
    );

    const first = await Effect.runPromise(
      enqueueNotification(targets, failure, { home, dedupeKey: "k" }).pipe(Effect.flip),
    );
    await Effect.runPromise(
      writeStateFile(outboxFilePath(baseDirectory, "phone"), OUTBOX_FILE_KIND, []),
    );
    const second = await Effect.runPromise(
      enqueueNotification(targets, failure, { home, dedupeKey: "k" }),
    );
    const third = await Effect.runPromise(
      enqueueNotification(targets, failure, { home, dedupeKey: "k" }),
    );

    expect(first).toBeInstanceOf(NotificationQueueError);
    expect((first as NotificationQueueError).queued).toEqual(["desk", "ops"]);
    expect(second).toEqual({ queued: ["phone"], missing: [], duplicate: false });
    expect(third).toMatchObject({ queued: [], duplicate: true });
  });

  it("treats a dedupe key recorded without a target as spent on every target", async () => {
    const home = temporaryHome();
    mkdirSync(path.join(home, "notify"), { recursive: true });
    writeFileSync(
      path.join(home, "notify", "sent.json"),
      JSON.stringify({ schemaVersion: 1, sent: { k: Date.now() } }),
    );

    const outcome = await Effect.runPromise(
      enqueueNotification(targets, failure, { home, dedupeKey: "k" }),
    );

    expect(outcome).toMatchObject({ queued: [], duplicate: true });
  });
});

describe("enqueueNotification on a host without a desktop notifier", () => {
  const withoutDesktop = {
    notify: () => Effect.void,
    desktopAvailable: () => Effect.succeed(false),
  } satisfies NotificationService;

  it("skips the implicit desktop target, and still queues a configured one", async () => {
    const home = temporaryHome();
    const run = (queueOn: readonly NotifyTarget[]) =>
      Effect.runPromise(
        enqueueNotification(queueOn, failure, { home }).pipe(
          Effect.provideService(NotificationServiceTag, withoutDesktop),
        ),
      );

    const implicit = await run(notifyTargets({}));
    const configured = await run(notifyTargets({ notify: { targets } }));

    expect(implicit).toEqual({ queued: [], missing: [], duplicate: false });
    expect(configured.queued).toEqual(["desk", "ops", "phone"]);
  });
});

describe("OUTBOX_FILE_KIND", () => {
  it("upgrades events queued before waiting and spend-cap, and drops only unreadable items", async () => {
    const home = temporaryHome();
    const baseDirectory = outboxDirectory(home);
    mkdirSync(baseDirectory, { recursive: true });
    const filePath = outboxFilePath(baseDirectory, "phone");
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        notifications: [
          {
            id: "a",
            fireAt: 1_000,
            event: {
              kind: "approval-needed",
              runId: "run-1",
              agentId: "agent-1",
              source: "workflow",
              name: "brief",
              pending: "tool-approval",
              request: "execute_command: rm -rf build",
              expiresAt: "2026-09-30T00:00:00.000Z",
            },
          },
          {
            id: "b",
            fireAt: 2_000,
            event: {
              kind: "spend-ceiling",
              source: "goal",
              agentId: "agent-1",
              message: "Daily cap of $5 reached.",
            },
          },
          { id: "c", fireAt: 3_000, event: { kind: "something-else" } },
          { id: "d", fireAt: 4_000, event: failure },
        ],
      }),
    );

    const items = await Effect.runPromise(
      readStateFile(filePath, OUTBOX_FILE_KIND, { onCorrupt: "fail" }),
    );

    expect(items?.map((item) => item.id)).toEqual(["a", "b", "d"]);
    expect(items?.[0]?.event).toEqual({
      kind: "waiting",
      item: {
        key: "run:run-1:tool-approval",
        kind: "approval",
        title: "Jazz run run-1 needs your approval",
        detail: "execute_command: rm -rf build\n\nIt waits until 2026-09-30T00:00:00.000Z.",
        since: new Date(1_000).toISOString(),
        runId: "run-1",
        agentId: "agent-1",
      },
    });
    expect(items?.[1]?.event).toEqual({
      kind: "spend-cap",
      source: "goal",
      agentId: "agent-1",
      message: "Daily cap of $5 reached.",
    });
    expect(readFileSync(filePath, "utf8")).toContain("approval-needed");
  });
});
