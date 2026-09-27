import { createHmac } from "node:crypto";
import type { NotifyEvent } from "@jazz/core/notify/events";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  type FetchLike,
  sendToChannel,
  splitMessage,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./channels";

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

describe("sendToChannel", () => {
  it("signs a webhook body with the shared secret over timestamp and body", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToChannel(
        "ops",
        { type: "webhook", url: "https://hooks.example.com/jazz", secret: "s3cret" },
        failure,
        { deliveryId: "d1", fetch, env: NO_ENV, now: 1_700_000_000_000 },
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

  it("refuses an unsigned webhook instead of posting it", async () => {
    const { fetch, calls } = fakeFetch(200);

    const outcome = await Effect.runPromise(
      sendToChannel("ops", { type: "webhook", url: "https://hooks.example.com" }, failure, {
        deliveryId: "d1",
        fetch,
        env: NO_ENV,
      }),
    );

    expect(outcome).toMatchObject({ delivered: false, retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("posts to Telegram's sendMessage with the chat id, keeping the token out of errors", async () => {
    const { fetch, calls } = fakeFetch(401, JSON.stringify({ description: "Unauthorized" }));

    const outcome = await Effect.runPromise(
      sendToChannel(
        "phone",
        {
          type: "telegram",
          chatId: "42",
          botToken: "123:SECRET",
          apiBaseUrl: "http://127.0.0.1:1",
        },
        failure,
        { deliveryId: "d1", fetch, env: NO_ENV },
      ),
    );

    expect(calls[0]?.url).toBe("http://127.0.0.1:1/bot123:SECRET/sendMessage");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ chat_id: "42" });
    expect(outcome).toMatchObject({ delivered: false, retryable: false });
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });

  it("retries a 429 or a 5xx, and a network failure", async () => {
    for (const status of [429, 503]) {
      const { fetch } = fakeFetch(status);
      const outcome = await Effect.runPromise(
        sendToChannel(
          "team",
          { type: "discord", webhookUrl: "https://discord.test/hook" },
          failure,
          {
            deliveryId: "d1",
            fetch,
            env: NO_ENV,
          },
        ),
      );
      expect(outcome).toMatchObject({ delivered: false, retryable: true });
    }
    const unreachable: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const outcome = await Effect.runPromise(
      sendToChannel("team", { type: "discord", webhookUrl: "https://discord.test/hook" }, failure, {
        deliveryId: "d1",
        fetch: unreachable,
        env: NO_ENV,
      }),
    );
    expect(outcome).toMatchObject({ delivered: false, retryable: true });
  });

  it("reads a channel secret from its environment variable first", async () => {
    const { fetch, calls } = fakeFetch(200);

    await Effect.runPromise(
      sendToChannel(
        "my-phone",
        { type: "telegram", chatId: "1", apiBaseUrl: "http://x.test" },
        failure,
        {
          deliveryId: "d1",
          fetch,
          env: { JAZZ_NOTIFY_MY_PHONE_BOT_TOKEN: "from-env" },
        },
      ),
    );

    expect(calls[0]?.url).toBe("http://x.test/botfrom-env/sendMessage");
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
