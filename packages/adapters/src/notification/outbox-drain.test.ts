import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { enqueueNotification } from "@jazz/core/notify/outbox";
import type { NotifyChannelConfig } from "@jazz/core/types/notify";
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

const channels: Record<string, NotifyChannelConfig> = {
  phone: { type: "telegram", chatId: "1" },
};

const configLayer = Layer.succeed(AgentConfigServiceTag, {
  appConfig: Effect.succeed({ notifications: { channels } }),
} as unknown as AgentConfigService);

function drain(home: string, now: number, outcome: DeliveryOutcome, sent: string[] = []) {
  const options: DrainOptions = {
    home,
    now,
    send: (channelName) =>
      Effect.sync(() => {
        sent.push(channelName);
        return outcome;
      }),
  };
  return Effect.runPromise(drainNotifyOutbox(options).pipe(Effect.provide(configLayer)));
}

async function queueOne(home: string, now: number) {
  await Effect.runPromise(
    enqueueNotification(
      channels,
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

    expect(report).toEqual({ delivered: 1, failed: 0 });
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
});
