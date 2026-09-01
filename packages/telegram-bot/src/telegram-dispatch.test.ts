import { afterEach, describe, expect, it } from "bun:test";
import {
  dispatchTelegramRequest,
  isRenderingRejection,
  resetTelegramDispatchState,
} from "./telegram-dispatch";

afterEach(() => {
  resetTelegramDispatchState();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function okBody(): Record<string, unknown> {
  return { ok: true, result: { message_id: 1 } };
}

function rateLimited(retryAfterSeconds: unknown): Record<string, unknown> {
  return {
    ok: false,
    error_code: 429,
    description: "Too Many Requests",
    parameters: { retry_after: retryAfterSeconds },
  };
}

describe("isRenderingRejection", () => {
  it("is true only for a definite non-429 rejection", () => {
    expect(isRenderingRejection({ ok: false, error_code: 400 })).toBe(true);
    expect(isRenderingRejection({ ok: false, error_code: 429 })).toBe(false);
    expect(isRenderingRejection({ ok: true })).toBe(false);
    expect(isRenderingRejection(undefined)).toBe(false);
    expect(isRenderingRejection(null)).toBe(false);
  });
});

describe("dispatchTelegramRequest — retry", () => {
  it("retries a confirmed 429 using retry_after, then succeeds", async () => {
    let calls = 0;
    const result = await dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 1,
      send: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse(429, rateLimited(0.01)) : jsonResponse(200, okBody());
      },
    });

    expect(calls).toBe(2);
    expect(result).toEqual(okBody());
  });

  it("gives up after the retry ceiling and returns the last rate-limit body", async () => {
    let calls = 0;
    const result = await dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 2,
      send: async () => {
        calls += 1;
        return jsonResponse(429, rateLimited(0.01));
      },
    });

    expect(calls).toBe(3);
    expect(result).toMatchObject({ error_code: 429 });
  });

  it("falls back to a default wait when retry_after is missing or malformed", async () => {
    let calls = 0;
    const start = Date.now();
    const result = await dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 3,
      send: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse(429, rateLimited("soon")) : jsonResponse(200, okBody());
      },
    });

    expect(calls).toBe(2);
    expect(result).toEqual(okBody());
    // The malformed value fell back to the ~1s default wait rather than 0 or NaN.
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it("never retries a network failure, since the outcome at Telegram is unknown", async () => {
    let calls = 0;
    const result = await dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 4,
      send: async () => {
        calls += 1;
        throw new Error("fetch failed: aborted");
      },
    });

    expect(calls).toBe(1);
    expect(result).toBeUndefined();
  });

  it("drops a best-effort request during a cooldown instead of waiting", async () => {
    let calls = 0;
    await dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 5,
      bestEffort: true,
      send: async () => {
        calls += 1;
        return jsonResponse(429, rateLimited(5));
      },
    });
    expect(calls).toBe(1);

    const start = Date.now();
    const result = await dispatchTelegramRequest({
      method: "editMessageText",
      chatId: 5,
      bestEffort: true,
      send: async () => {
        calls += 1;
        return jsonResponse(200, okBody());
      },
    });

    expect(result).toBeUndefined();
    expect(calls).toBe(1);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("dispatchTelegramRequest — shared cooldown", () => {
  it("makes a later call to a different chat wait out an earlier chat's rate limit", async () => {
    await dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 10,
      bestEffort: true,
      send: async () => jsonResponse(429, rateLimited(0.05)),
    });

    const start = Date.now();
    const result = await dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 11,
      send: async () => jsonResponse(200, okBody()),
    });

    expect(result).toEqual(okBody());
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

describe("dispatchTelegramRequest — per-chat ordering", () => {
  it("runs requests for the same chat in the order they were issued", async () => {
    const order: number[] = [];
    const first = dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 20,
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(1);
        return jsonResponse(200, okBody());
      },
    });
    const second = dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 20,
      send: async () => {
        order.push(2);
        return jsonResponse(200, okBody());
      },
    });

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("does not serialize requests for different chats against each other", async () => {
    const order: number[] = [];
    const slow = dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 30,
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(1);
        return jsonResponse(200, okBody());
      },
    });
    const fast = dispatchTelegramRequest({
      method: "sendMessage",
      chatId: 31,
      send: async () => {
        order.push(2);
        return jsonResponse(200, okBody());
      },
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual([2, 1]);
  });
});

describe("dispatchTelegramRequest — photo uploads", () => {
  it("carries a multipart form request through the same dispatcher", async () => {
    let receivedForm: FormData | undefined;
    const result = await dispatchTelegramRequest({
      method: "sendPhoto",
      chatId: 40,
      send: async () => {
        const form = new FormData();
        form.append("chat_id", "40");
        receivedForm = form;
        return jsonResponse(200, okBody());
      },
    });

    expect(result).toEqual(okBody());
    expect(receivedForm).toBeInstanceOf(FormData);
  });

  it("retries a photo upload's confirmed 429 the same way as a JSON call", async () => {
    let calls = 0;
    const result = await dispatchTelegramRequest({
      method: "sendPhoto",
      chatId: 41,
      send: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse(429, rateLimited(0.01)) : jsonResponse(200, okBody());
      },
    });

    expect(calls).toBe(2);
    expect(result).toEqual(okBody());
  });
});
