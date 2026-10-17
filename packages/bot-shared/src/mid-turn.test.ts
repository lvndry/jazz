import { describe, expect, test } from "bun:test";
import { routeBusyMessage, takeNextTurn } from "./mid-turn";
import type { InboundMessage } from "./turn";

const isCommand = (text: string): boolean => text.startsWith("/");

function inbound(text: string, senderId = "u1"): InboundMessage {
  return { chatId: "c1", senderId, text };
}

describe("routeBusyMessage", () => {
  test("the requester's plain message goes into the run in flight", () => {
    expect(
      routeBusyMessage({ runInFlight: true, requester: "u1", senderId: "u1", isCommand: false }),
    ).toBe("into-run");
  });

  test("a command, another sender, or no run yet waits in the queue", () => {
    expect(
      routeBusyMessage({ runInFlight: true, requester: "u1", senderId: "u1", isCommand: true }),
    ).toBe("queue");
    expect(
      routeBusyMessage({ runInFlight: true, requester: "u1", senderId: "u2", isCommand: false }),
    ).toBe("queue");
    expect(
      routeBusyMessage({
        runInFlight: false,
        requester: undefined,
        senderId: "u1",
        isCommand: false,
      }),
    ).toBe("queue");
  });
});

describe("takeNextTurn", () => {
  test("joins one sender's consecutive plain messages into one turn", () => {
    const queue = [inbound("for 4 people"), inbound("around 8pm"), inbound("hi", "u2")];
    expect(takeNextTurn(queue, isCommand)?.text).toBe("for 4 people\naround 8pm");
    expect(queue.map((message) => message.text)).toEqual(["hi"]);
  });

  test("a command is taken on its own and stops a run of plain messages", () => {
    const queue = [inbound("/model"), inbound("first"), inbound("/status"), inbound("second")];
    expect(takeNextTurn(queue, isCommand)?.text).toBe("/model");
    expect(takeNextTurn(queue, isCommand)?.text).toBe("first");
    expect(takeNextTurn(queue, isCommand)?.text).toBe("/status");
    expect(takeNextTurn(queue, isCommand)?.text).toBe("second");
    expect(takeNextTurn(queue, isCommand)).toBeUndefined();
  });
});
