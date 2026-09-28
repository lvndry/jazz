import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { enqueueNotification } from "@jazz/core/notify/outbox";
import type { NotifyTarget } from "@jazz/core/types/notify";
import { DELIVERY_RETRY_INITIAL_MS, type DeliveryOutcome } from "@jazz/core/utils/delivery";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import {
  type DrainOptions,
  drainNotifyOutbox,
  listOutbox,
  retryStoppedNotifications,
} from "./outbox-drain";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "jazz-outbox-drain-"));
  homes.push(home);
  return home;
}

const targets: readonly NotifyTarget[] = [
  { name: "phone", kind: "telegram", chatId: "1" },
  { name: "desk", kind: "desktop" },
];

const configLayer = Layer.succeed(AgentConfigServiceTag, {
  appConfig: Effect.succeed({ notify: { targets } }),
} as unknown as AgentConfigService);

function drain(home: string, now: number, outcome: DeliveryOutcome, sent: string[] = []) {
  const options: DrainOptions = {
    home,
    now,
    send: (target) =>
      Effect.sync(() => {
        sent.push(target.name);
        return outcome;
      }),
  };
  return Effect.runPromise(drainNotifyOutbox(options).pipe(Effect.provide(configLayer)));
}

async function queueOne(
  home: string,
  now: number,
  onTargets: readonly NotifyTarget[] = targets.slice(0, 1),
) {
  await Effect.runPromise(
    enqueueNotification(
      onTargets,
      { kind: "unattended-failed", source: "workflow", error: "boom" },
      { home, now },
    ),
  );
}

describe("drainNotifyOutbox", () => {
  it("removes a notification once its channel accepts it", async () => {
    const home = temporaryHome();
    await queueOne(home, 1_000);

    const report = await drain(home, 1_000, { delivered: true });

    expect(report).toEqual({ delivered: 1, failed: 0, dropped: 0 });
    expect(await Effect.runPromise(listOutbox(home))).toEqual([]);
  });

  it("keeps a failed send with its error and retries it once the backoff has passed", async () => {
    const home = temporaryHome();
    await queueOne(home, 1_000);
    const sent: string[] = [];

    await drain(
      home,
      1_000,
      { delivered: false, error: "Telegram answered HTTP 503", retryable: true },
      sent,
    );
    const kept = await Effect.runPromise(listOutbox(home));
    await drain(home, 1_000 + DELIVERY_RETRY_INITIAL_MS - 1, { delivered: true }, sent);
    await drain(home, 1_000 + DELIVERY_RETRY_INITIAL_MS, { delivered: true }, sent);

    expect(kept[0]?.delivery).toMatchObject({
      status: "retrying",
      attempts: 1,
      lastError: "Telegram answered HTTP 503",
    });
    expect(sent).toEqual(["phone", "phone"]);
    expect(await Effect.runPromise(listOutbox(home))).toEqual([]);
  });

  it("stops retrying a refusal but keeps it visible, and retry re-arms it", async () => {
    const home = temporaryHome();
    await queueOne(home, 1_000);

    await drain(home, 1_000, { delivered: false, error: "HTTP 401", retryable: false });
    const stopped = await Effect.runPromise(listOutbox(home));
    const rearmed = await Effect.runPromise(retryStoppedNotifications(home));
    const report = await drain(home, 2_000, { delivered: true });

    expect(stopped[0]?.delivery).toMatchObject({ status: "failed", lastError: "HTTP 401" });
    expect(rearmed).toBe(1);
    expect(report.delivered).toBe(1);
  });

  it("drops a desktop notification that cannot be shown instead of keeping it failed", async () => {
    const home = temporaryHome();
    await queueOne(home, 1_000, targets);

    const report = await drain(home, 1_000, {
      delivered: false,
      error: "terminal-notifier not found",
      retryable: false,
    });
    const left = await Effect.runPromise(listOutbox(home));

    expect(report).toEqual({ delivered: 0, failed: 2, dropped: 1 });
    expect(left.map((entry) => entry.target)).toEqual(["phone"]);
    expect(left[0]?.delivery).toMatchObject({ status: "failed" });
  });
});
