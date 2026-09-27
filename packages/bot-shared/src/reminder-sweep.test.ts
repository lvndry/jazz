import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readReminders } from "./reminder-store";
import { sweepRemindersOnce } from "./reminder-sweep";
import { renderPlain, type RichText } from "./surface";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "reminder-sweep-"));
  mkdirSync(join(dataDir, "reminders"));
  const due = (id: string, text: string) => ({
    id,
    fireAt: Date.now() - 1_000,
    text,
    createdAt: 0,
  });
  writeFileSync(
    join(dataDir, "reminders", "t_1.json"),
    JSON.stringify([due("a", "first"), due("b", "second")]),
  );
  writeFileSync(join(dataDir, "reminders", "other_1.json"), JSON.stringify([due("c", "not ours")]));
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const remaining = (file: string): string[] =>
  readReminders(dataDir, file.slice(0, -5)).map((reminder) => reminder.id);

describe("the reminder sweep", () => {
  test("a failed send keeps that reminder, delivers the rest, and retries next sweep", async () => {
    const delivered: string[] = [];
    let failFirst = true;
    const options = {
      dataDir,
      decodeScope: (agentId: string) => (agentId === "t_1" ? "1" : undefined),
      send: (_chatId: string, body: RichText) => {
        const text = renderPlain(body);
        if (failFirst && text.includes("first")) {
          return Promise.reject(new Error("socket down"));
        }
        delivered.push(text);
        return Promise.resolve();
      },
    };
    await sweepRemindersOnce(options);
    expect(delivered.some((text) => text.includes("second"))).toBe(true);
    expect(remaining("t_1.json")).toEqual(["a"]);

    failFirst = false;
    await sweepRemindersOnce(options);
    expect(delivered.some((text) => text.includes("first"))).toBe(false);
    const file = join(dataDir, "reminders", "t_1.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.reminders[0].delivery.nextAttemptAt = 0;
    writeFileSync(file, JSON.stringify(state));
    await sweepRemindersOnce(options);
    expect(delivered.some((text) => text.includes("first"))).toBe(true);
    expect(remaining("t_1.json")).toEqual([]);
    // Another bridge's reminders are left untouched.
    expect(remaining("other_1.json")).toEqual(["c"]);
  });
});
