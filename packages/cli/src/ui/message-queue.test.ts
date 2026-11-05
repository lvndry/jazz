import { describe, expect, it } from "bun:test";
import {
  followUpCount,
  hasSteering,
  queueText,
  takeNextTurn,
  takeSteering,
  type QueueEntry,
} from "./message-queue";

const steer = (text: string): QueueEntry => ({ text, lane: "steer" });
const followUp = (text: string): QueueEntry => ({ text, lane: "followup" });

describe("takeSteering", () => {
  it("delivers steering entries in order and leaves follow-ups queued", () => {
    const queue = [steer("a"), followUp("later"), steer("b")];

    const { taken, rest } = takeSteering(queue);

    expect(taken).toEqual(["a", "b"]);
    expect(rest).toEqual([followUp("later")]);
  });

  it("delivers nothing when only follow-ups are queued", () => {
    const queue = [followUp("one"), followUp("two")];

    const { taken, rest } = takeSteering(queue);

    expect(taken).toEqual([]);
    expect(rest).toBe(queue);
    expect(hasSteering(queue)).toBe(false);
  });

  it("stops at the first command, which holds back steering behind it", () => {
    const queue = [steer("a"), steer("/compact"), steer("b")];

    const { taken, rest } = takeSteering(queue);

    expect(taken).toEqual(["a"]);
    expect(rest).toEqual([steer("/compact"), steer("b")]);
    expect(hasSteering([steer("/compact"), steer("b")])).toBe(false);
  });
});

describe("takeNextTurn", () => {
  it("sends each follow-up as a turn of its own, in queue order", () => {
    let queue: readonly QueueEntry[] = [followUp("one"), followUp("two"), steer("note")];
    const turns: (readonly string[])[] = [];
    while (queue.length > 0) {
      const next = takeNextTurn(queue);
      turns.push(next.taken);
      queue = next.rest;
    }

    expect(turns).toEqual([["one"], ["two"], ["note"]]);
  });

  it("combines a run of steering entries and ends it at the next follow-up or command", () => {
    const queue = [steer("a"), steer("b"), followUp("later"), steer("c"), steer("/info")];

    const first = takeNextTurn(queue);
    const second = takeNextTurn(first.rest);
    const third = takeNextTurn(second.rest);
    const fourth = takeNextTurn(third.rest);

    expect(first.taken).toEqual(["a", "b"]);
    expect(second.taken).toEqual(["later"]);
    expect(third.taken).toEqual(["c"]);
    expect(fourth.taken).toEqual(["/info"]);
    expect(fourth.rest).toEqual([]);
  });

  it("takes nothing from an empty queue", () => {
    expect(takeNextTurn([]).taken).toEqual([]);
  });
});

describe("a run that ends with entries still queued", () => {
  it("steering reaches the run first, then the follow-up becomes the next turn", () => {
    const queue = [followUp("then summarize"), steer("use the staging db")];

    const duringRun = takeSteering(queue);
    const afterRun = takeNextTurn(duringRun.rest);

    expect(duringRun.taken).toEqual(["use the staging db"]);
    expect(afterRun.taken).toEqual(["then summarize"]);
    expect(afterRun.rest).toEqual([]);
  });
});

describe("queue summaries", () => {
  it("recalls every entry's text for editing and counts follow-ups", () => {
    const queue = [steer("a"), followUp("b")];

    expect(queueText(queue)).toBe("a\nb");
    expect(followUpCount(queue)).toBe(1);
  });
});
