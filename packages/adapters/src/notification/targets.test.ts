import { createHmac } from "node:crypto";
import type { NotifyEvent } from "@jazz/core/notify/events";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  type FetchLike,
  type KeyringReader,
  resolveTargetSecret,
  sendToTarget,
  splitMessage,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookBody,
} from "./targets";

const failure: NotifyEvent = {
  kind: "unattended-failed",
  source: "workflow",
  name: "brief",
  error: "provider down",
};

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body = "{}"): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(body, { status });
    },
  };
}

const NO_ENV: NodeJS.ProcessEnv = {};

describe("sendToTarget", () => {
  it("signs a webhook body with the target's secret over timestamp and body", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToTarget(
        { name: "ops", kind: "webhook", url: "https://hooks.example.com/jazz" },
        failure,
        {
          deliveryId: "d1",
          fetch,
          env: { JAZZ_NOTIFY_OPS_SECRET: "s3cret" },
          now: 1_700_000_000_000,
        },
      ),
    );

    expect(outcome).toEqual({ delivered: true });
    const headers = calls[0]?.init.headers as Record<string, string>;
    const body = String(calls[0]?.init.body);
    const expected = createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex");
    expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBe("1700000000");
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(`sha256=${expected}`);
    expect(JSON.parse(body)).toMatchObject({ id: "d1", type: "unattended-failed", event: failure });
  });

  it("posts a webhook target without a secret unsigned", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToTarget({ name: "ops", kind: "webhook", url: "https://hooks.example.com" }, failure, {
        deliveryId: "d1",
        fetch,
        env: NO_ENV,
      }),
    );

    expect(outcome).toEqual({ delivered: true });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ title: expect.any(String) });
  });

  it("pushes to an ntfy topic with the title in a header and the text as the body", async () => {
    const { fetch, calls } = fakeFetch(200);

    await Effect.runPromise(
      sendToTarget({ name: "phone", kind: "ntfy", url: "https://ntfy.sh/topic" }, failure, {
        deliveryId: "d1",
        fetch,
        env: NO_ENV,
      }),
    );

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("https://ntfy.sh/topic");
    expect(headers["Title"]).toBe('Jazz workflow "brief" failed');
    expect(String(calls[0]?.init.body)).toContain("provider down");
  });

  it("posts to Telegram's sendMessage with the chat id, keeping the token out of errors", async () => {
    const { fetch, calls } = fakeFetch(401, JSON.stringify({ description: "Unauthorized" }));

    const outcome = await Effect.runPromise(
      sendToTarget(
        { name: "phone", kind: "telegram", chatId: "42", apiBaseUrl: "http://127.0.0.1:1" },
        failure,
        { deliveryId: "d1", fetch, env: { JAZZ_NOTIFY_PHONE_BOT_TOKEN: "123:SECRET" } },
      ),
    );

    expect(calls[0]?.url).toBe("http://127.0.0.1:1/bot123:SECRET/sendMessage");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ chat_id: "42" });
    expect(outcome).toMatchObject({ delivered: false, retryable: false });
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it("refuses a Telegram target with no bot token instead of posting", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToTarget({ name: "phone", kind: "telegram", chatId: "42" }, failure, {
        deliveryId: "d1",
        fetch,
        env: NO_ENV,
      }),
    );

    expect(outcome).toMatchObject({ delivered: false, retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("retries a 429 or a 5xx, and a network failure", async () => {
    const discord = { name: "team", kind: "discord" } as const;
    const env = { JAZZ_NOTIFY_TEAM_WEBHOOK_URL: "https://discord.test/hook" };
    for (const status of [429, 503]) {
      const { fetch } = fakeFetch(status);
      const outcome = await Effect.runPromise(
        sendToTarget(discord, failure, { deliveryId: "d1", fetch, env }),
      );
      expect(outcome).toMatchObject({ delivered: false, retryable: true });
    }
    const unreachable: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const outcome = await Effect.runPromise(
      sendToTarget(discord, failure, { deliveryId: "d1", fetch: unreachable, env }),
    );
    expect(outcome).toMatchObject({ delivered: false, retryable: true });
  });
});

describe("splitMessage", () => {
  it("splits on line breaks and truncates past the part limit", () => {
    const text = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");

    const parts = splitMessage(text, 40, 3);

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.length <= 40)).toBe(true);
    expect(parts[2]).toEndWith("[truncated]");
  });
});

function fakeKeyring(entries: Readonly<Record<string, string>>) {
  const reads: string[] = [];
  const readKeyring: KeyringReader = (secretPath) =>
    Effect.sync(() => {
      reads.push(secretPath);
      return entries[secretPath];
    });
  return { reads, readKeyring };
}

const EMPTY_KEYRING: KeyringReader = () => Effect.succeed(undefined);

describe("resolveTargetSecret", () => {
  it("reads a secret from its environment variable first", async () => {
    const { reads, readKeyring } = fakeKeyring({ "notify.targets.phone.botToken": "from-keyring" });

    const secret = await Effect.runPromise(
      resolveTargetSecret(
        "phone",
        "botToken",
        { JAZZ_NOTIFY_PHONE_BOT_TOKEN: " from-env " },
        readKeyring,
      ),
    );

    expect(secret).toBe("from-env");
    expect(reads).toEqual([]);
  });

  it("falls back to the keyring when the environment variable is unset or blank", async () => {
    const { reads, readKeyring } = fakeKeyring({ "notify.targets.phone.botToken": "from-keyring" });

    const secret = await Effect.runPromise(
      resolveTargetSecret("phone", "botToken", { JAZZ_NOTIFY_PHONE_BOT_TOKEN: "  " }, readKeyring),
    );

    expect(secret).toBe("from-keyring");
    expect(reads).toEqual(["notify.targets.phone.botToken"]);
  });
});

describe("sendToTarget to Discord", () => {
  it("posts as a bot into the channel when it has a bot token and a channel id", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToTarget(
        { name: "team", kind: "discord", channelId: "99", apiBaseUrl: "http://127.0.0.1:1" },
        failure,
        {
          deliveryId: "d1",
          fetch,
          env: { JAZZ_NOTIFY_TEAM_BOT_TOKEN: "bot-secret" },
          readKeyring: EMPTY_KEYRING,
        },
      ),
    );

    expect(outcome).toEqual({ delivered: true });
    expect(calls[0]?.url).toBe("http://127.0.0.1:1/channels/99/messages");
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bot bot-secret",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      allowed_mentions: { parse: [] },
    });
  });

  it("posts through the webhook URL when there is no channel id, even with a bot token", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToTarget({ name: "team", kind: "discord" }, failure, {
        deliveryId: "d1",
        fetch,
        env: {
          JAZZ_NOTIFY_TEAM_BOT_TOKEN: "bot-secret",
          JAZZ_NOTIFY_TEAM_WEBHOOK_URL: "https://discord.example/api/webhooks/1/abc",
        },
        readKeyring: EMPTY_KEYRING,
      }),
    );

    expect(outcome).toEqual({ delivered: true });
    expect(calls[0]?.url).toBe("https://discord.example/api/webhooks/1/abc");
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("refuses without posting when it has neither a webhook URL nor a bot token", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToTarget({ name: "team", kind: "discord", channelId: "99" }, failure, {
        deliveryId: "d1",
        fetch,
        env: NO_ENV,
        readKeyring: EMPTY_KEYRING,
      }),
    );

    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ delivered: false, retryable: false });
    expect(outcome.delivered ? "" : outcome.error).toContain("needs a webhookUrl");
  });
});

describe("webhookBody", () => {
  it("carries the delivery id, the event kind, the rendered text and the event", () => {
    expect(JSON.parse(webhookBody("d1", failure))).toEqual({
      id: "d1",
      type: "unattended-failed",
      title: 'Jazz workflow "brief" failed',
      body: "provider down",
      event: failure,
    });
  });
});
