import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { cancelReminder, claimDueReminders, readReminders, settleReminder } from "./reminder-store";

function homeWith(content: string): string {
  const home = mkdtempSync(join(tmpdir(), "jazz-bridge-reminders-"));
  mkdirSync(join(home, "reminders"));
  writeFileSync(join(home, "reminders", "tg_1.json"), content);
  return home;
}

function stored(home: string): {
  schemaVersion: number;
  reminders: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(join(home, "reminders", "tg_1.json"), "utf8"));
}

const due = { id: "a", fireAt: 1, text: "due", createdAt: 0 };
const later = { id: "b", fireAt: Number.MAX_SAFE_INTEGER, text: "later", createdAt: 0 };

describe("bridge reminder store", () => {
  it("claims a due reminder, keeps it until the send succeeds, then removes it", async () => {
    const home = homeWith(JSON.stringify({ schemaVersion: 2, reminders: [due, later] }));
    const claimed = await claimDueReminders(home, "tg_1", 10, undefined);
    expect(claimed.map((reminder) => reminder.id)).toEqual(["a"]);
    expect(stored(home).reminders.map((reminder) => reminder["id"])).toEqual(["a", "b"]);
    expect(await claimDueReminders(home, "tg_1", 10, undefined)).toEqual([]);

    await settleReminder(home, "tg_1", "a", { delivered: true }, undefined);
    expect(stored(home)).toEqual({ schemaVersion: 2, reminders: [later] });
  });

  /** The regression: the sweep removed a reminder before sending it, so a failed send lost it. */
  it("keeps a reminder whose send failed, with the error", async () => {
    const home = homeWith(JSON.stringify({ schemaVersion: 2, reminders: [due] }));
    await claimDueReminders(home, "tg_1", 10, undefined);
    await settleReminder(
      home,
      "tg_1",
      "a",
      { delivered: false, error: "chat unreachable", retryable: true },
      undefined,
    );
    const [kept] = readReminders(home, "tg_1");
    expect(kept?.delivery).toMatchObject({ status: "failed", lastError: "chat unreachable" });
  });

  it("reads a file written before schema versions", () => {
    const home = homeWith(JSON.stringify([due]));
    expect(readReminders(home, "tg_1").map((reminder) => reminder.id)).toEqual(["a"]);
  });

  it("never rewrites a corrupt file or one from a newer Jazz", async () => {
    for (const content of ["[{torn", JSON.stringify({ schemaVersion: 99, reminders: [due] })]) {
      const home = homeWith(content);
      expect(await claimDueReminders(home, "tg_1", 10, undefined)).toEqual([]);
      expect(await cancelReminder(home, "tg_1", "a", undefined)).toBe(false);
      expect(readFileSync(join(home, "reminders", "tg_1.json"), "utf8")).toBe(content);
    }
  });
});
