/** Privacy-safe misfire report lifecycle. External submission is intentionally injected. */

import type { SafeMisfireReport } from "@/core/agent/tools/misfire-report";

export interface PendingMisfireReport {
  readonly id: string;
  readonly report: SafeMisfireReport;
  readonly preview: string;
  readonly status: "pending" | "sent" | "declined";
  readonly createdAt: string;
}

/** Render the exact payload preview shown before an external report is submitted. */
export function previewMisfireReport(report: SafeMisfireReport): string {
  return [
    "Jazz diagnostic report — nothing has been sent",
    `Tool: ${report.toolName}`,
    `Failure: ${report.errorClass}`,
    `Occurrences: ${report.occurrences}`,
    `Jazz: ${report.jazzVersion} (${report.platform})`,
    `Duration: ${report.durationMs.min}-${report.durationMs.max}ms`,
    "Payload contains no raw arguments, conversation, memory, credentials, or user identifiers.",
  ].join("\n");
}

/** Create a local pending report. This function performs no network operation. */
export function createPendingMisfireReport(
  report: SafeMisfireReport,
  now = new Date().toISOString(),
): PendingMisfireReport {
  const id = `report_${now.replace(/[^0-9]/g, "").slice(-14)}`;
  return { id, report, preview: previewMisfireReport(report), status: "pending", createdAt: now };
}

/** Require an explicit decision before invoking the injected external sender. */
export async function submitConfirmedMisfireReport(
  pending: PendingMisfireReport,
  decision: "send" | "decline",
  send: (report: SafeMisfireReport) => Promise<void>,
): Promise<PendingMisfireReport> {
  if (pending.status !== "pending") return pending;
  if (decision === "decline") return { ...pending, status: "declined" };
  await send(pending.report);
  return { ...pending, status: "sent" };
}
