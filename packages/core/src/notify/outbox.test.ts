import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { NotifyTarget } from "@/core/types/notify";
import { readStateFile } from "@/core/utils/state-file";
import type { NotifyEvent } from "./events";
import {
  enqueueNotification,
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
});
