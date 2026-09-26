import { describe, expect, it } from "bun:test";
import { splitLoopArguments } from "./loop";

describe("splitLoopArguments", () => {
  it("reads a leading interval, with or without `every`", () => {
    expect(splitLoopArguments(["10m", "check", "the", "deploy"])).toEqual({
      schedule: "10m",
      prompt: "check the deploy",
    });
    expect(splitLoopArguments(["every", "1h30m", "sweep", "my", "inbox"])).toEqual({
      schedule: "1h30m",
      prompt: "sweep my inbox",
    });
  });

  it("reads the five cron fields after `cron`", () => {
    expect(
      splitLoopArguments(["cron", "0", "9", "*", "*", "mon-fri", "plan", "my", "day"]),
    ).toEqual({ schedule: "0 9 * * mon-fri", prompt: "plan my day" });
  });

  it("refuses a schedule with no prompt after it", () => {
    expect(splitLoopArguments(["10m"])).toBeUndefined();
    expect(splitLoopArguments(["every", "10m"])).toBeUndefined();
    expect(splitLoopArguments(["cron", "0", "9", "*", "*", "mon"])).toBeUndefined();
    expect(splitLoopArguments([])).toBeUndefined();
  });
});
