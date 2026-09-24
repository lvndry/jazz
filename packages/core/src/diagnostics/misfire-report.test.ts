import { describe, expect, test } from "bun:test";
import type { SafeMisfireReport } from "@/core/agent/tools/misfire-report";
import { createPendingMisfireReport, submitConfirmedMisfireReport } from "./misfire-report";

const report: SafeMisfireReport = {
  jazzVersion: "0.15.0",
  platform: "darwin/arm64",
  toolName: "edit_file",
  kind: "runtime_error",
  errorClass: "pattern not found",
  occurrences: 2,
  durationMs: { min: 1, max: 10 },
};

describe("misfire report lifecycle", () => {
  test("does not send until explicitly confirmed", async () => {
    const pending = createPendingMisfireReport(report, "2026-09-22T10:00:00.000Z");
    let sent = false;
    const declined = await submitConfirmedMisfireReport(pending, "decline", async () => {
      sent = true;
    });
    expect(sent).toBe(false);
    expect(declined.status).toBe("declined");
  });

  test("sends exactly the safe report after confirmation", async () => {
    const pending = createPendingMisfireReport(report, "2026-09-22T10:00:00.000Z");
    let sentReport: SafeMisfireReport | undefined;
    const sent = await submitConfirmedMisfireReport(pending, "send", async (value) => {
      sentReport = value;
    });
    expect(sent.status).toBe("sent");
    expect(sentReport).toEqual(report);
  });
});
