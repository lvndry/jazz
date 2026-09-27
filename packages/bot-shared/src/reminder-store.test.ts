import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { cancelReminder, readReminders, takeDueReminders } from "./reminder-store";

function homeWith(content: string): string {
  const home = mkdtempSync(join(tmpdir(), "jazz-bridge-reminders-"));
  mkdirSync(join(home, "reminders"));
  writeFileSync(join(home, "reminders", "tg_1.json"), content);
  return home;
}

const due = { id: "a", fireAt: 1, text: "due", createdAt: 0 };
const later = { id: "b", fireAt: Number.MAX_SAFE_INTEGER, text: "later", createdAt: 0 };

describe("bridge reminder store", () => {
  it("reads and rewrites the agent's versioned file", async () => {
    const home = homeWith(JSON.stringify({ schemaVersion: 1, reminders: [due, later] }));
    expect(readReminders(home, "tg_1").map((reminder) => reminder.id)).toEqual(["a", "b"]);
    const taken = await takeDueReminders(home, "tg_1", 10, undefined);
    expect(taken.map((reminder) => reminder.id)).toEqual(["a"]);
    const stored = JSON.parse(readFileSync(join(home, "reminders", "tg_1.json"), "utf8"));
    expect(stored).toEqual({ schemaVersion: 1, reminders: [later] });
  });

  it("reads a file written before schema versions", () => {
    const home = homeWith(JSON.stringify([due]));
    expect(readReminders(home, "tg_1").map((reminder) => reminder.id)).toEqual(["a"]);
  });

  it("never rewrites a corrupt file or one from a newer Jazz", async () => {
    for (const content of ["[{torn", JSON.stringify({ schemaVersion: 99, reminders: [due] })]) {
      const home = homeWith(content);
      expect(await takeDueReminders(home, "tg_1", 10, undefined)).toEqual([]);
      expect(await cancelReminder(home, "tg_1", "a", undefined)).toBe(false);
      expect(readFileSync(join(home, "reminders", "tg_1.json"), "utf8")).toBe(content);
    }
  });
});
