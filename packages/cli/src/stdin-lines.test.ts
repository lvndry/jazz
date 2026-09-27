import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { createLineSource } from "./stdin-lines";

/** Resolves "pending" when the promise has not settled within a few event-loop turns. */
async function settledOrPending<T>(promise: Promise<T>): Promise<T | "pending"> {
  const pending = new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 30));
  return Promise.race([promise, pending]);
}

describe("createLineSource", () => {
  test("waits for a line instead of resolving while the stream is open and empty", async () => {
    const input = new PassThrough();
    const source = createLineSource(input);

    const next = source.next();
    expect(await settledOrPending(next)).toBe("pending");

    input.write("hello\n");
    expect(await next).toBe("hello");
    source.close();
  });

  test("hands out lines from one chunk in order, then undefined at end of input", async () => {
    const input = new PassThrough();
    const source = createLineSource(input);
    input.end("first\nsecond\r\nthird");

    expect(await source.next()).toBe("first");
    expect(await source.next()).toBe("second");
    expect(await source.next()).toBe("third");
    expect(await source.next()).toBeUndefined();
    expect(await source.next()).toBeUndefined();
  });

  test("close resolves a pending read with undefined", async () => {
    const input = new PassThrough();
    const source = createLineSource(input);
    const next = source.next();

    source.close();

    expect(await next).toBeUndefined();
  });
});
