import { afterEach, describe, expect, it } from "bun:test";
import { forceSendQueue } from "./queue-force-send";
import { store } from "./store";

describe("forceSendQueue", () => {
  afterEach(() => {
    store.clearQueue();
    store.consumeFlushQueue();
  });

  it("queues the draft behind earlier entries, requests a flush and interrupts once", () => {
    let interrupted = 0;
    store.appendToQueue("first");

    const outcome = forceSendQueue("second", () => {
      interrupted += 1;
    });

    expect(outcome).toBe("sent");
    expect(store.getMessageQueueSnapshot()).toEqual(["first", "second"]);
    expect(store.consumeFlushQueue()).toBe(true);
    expect(interrupted).toBe(1);
  });

  it("does nothing with an empty draft and an empty queue", () => {
    let interrupted = 0;

    const outcome = forceSendQueue("", () => {
      interrupted += 1;
    });

    expect(outcome).toBe("nothing-to-send");
    expect(store.consumeFlushQueue()).toBe(false);
    expect(interrupted).toBe(0);
  });

  it("leaves the draft and queue alone when no run can be interrupted", () => {
    const outcome = forceSendQueue("draft", null);

    expect(outcome).toBe("no-run");
    expect(store.getMessageQueueSnapshot()).toEqual([]);
    expect(store.consumeFlushQueue()).toBe(false);
  });
});
