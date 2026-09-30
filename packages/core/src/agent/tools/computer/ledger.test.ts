import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { appendLedgerEntry, ledgerLabel, ledgerPath, readLedger } from "./ledger";
import { useTemporaryJazzHome } from "./test-home";

useTemporaryJazzHome();

describe("ledgerLabel", () => {
  test("redacts a known secret and shortens a long label", () => {
    const label = ledgerLabel(`Reset hunter2-secret ${"x".repeat(200)}`, [
      { name: "typed", value: "hunter2-secret" },
    ]);
    expect(label).not.toContain("hunter2-secret");
    expect(label.length).toBeLessThanOrEqual(60);
  });

  test("collapses whitespace", () => {
    expect(ledgerLabel("a \n\n  b", [])).toBe("a b");
  });
});

describe("the ledger", () => {
  test("reads back the latest entries, newest first", async () => {
    for (const action of ["observe", "click", "type"]) {
      await appendLedgerEntry({
        timestamp: new Date().toISOString(),
        agentId: "agent",
        bundleId: "com.apple.mail",
        app: "Mail",
        action,
        outcome: "ok",
      });
    }
    expect((await readLedger(2)).map((entry) => entry.action)).toEqual(["type", "click"]);
  });

  test("skips a line it cannot read", async () => {
    await appendLedgerEntry({
      timestamp: new Date().toISOString(),
      agentId: "agent",
      bundleId: "com.apple.mail",
      app: "Mail",
      action: "observe",
      outcome: "ok",
    });
    await Bun.write(ledgerPath(), `${readFileSync(ledgerPath(), "utf8")}garbage\n`);
    expect((await readLedger(10)).map((entry) => entry.action)).toEqual(["observe"]);
  });
});
