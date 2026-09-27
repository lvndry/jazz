/**
 * `jazz spend`: what this machine's runs cost today and this month, broken down by agent and by
 * source, and where each configured `daemon` spend cap stands. Reads the machine-wide ledger under
 * `$JAZZ_HOME/spend` (see `@jazz/core/spend/ledger`).
 */

import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { type CapStatus, capStatuses } from "@jazz/core/spend/caps";
import { type DaySpend, readSpend, type SpendTotals } from "@jazz/core/spend/ledger";
import { SPEND_SOURCE_LABELS, type SpendSource } from "@jazz/core/spend/sources";
import { Effect } from "effect";
import { emitEnvelope, failEnvelope } from "../helpers/json-output";

function dollars(amount: number): string {
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
}

function describeTotals(totals: SpendTotals): string {
  const unpriced = totals.unpricedRuns > 0 ? ` (${totals.unpricedRuns} unpriced)` : "";
  return `${dollars(totals.costUSD)} · ${totals.runs} run${totals.runs === 1 ? "" : "s"} · ${totals.tokens.toLocaleString("en-US")} tokens${unpriced}`;
}

function breakdown(
  title: string,
  entries: ReadonlyArray<readonly [string, SpendTotals]>,
): readonly string[] {
  if (entries.length === 0) {
    return [];
  }
  const sorted = [...entries].sort((left, right) => right[1].costUSD - left[1].costUSD);
  const width = Math.max(...sorted.map(([name]) => name.length));
  return [
    "",
    title,
    ...sorted.map(([name, totals]) => `  ${name.padEnd(width)}  ${describeTotals(totals)}`),
  ];
}

function sourceEntries(day: DaySpend): ReadonlyArray<readonly [string, SpendTotals]> {
  return (Object.entries(day.bySource) as [SpendSource, SpendTotals][]).map(
    ([source, totals]) => [SPEND_SOURCE_LABELS[source], totals] as const,
  );
}

function describeCap(cap: CapStatus): string {
  const amount = (value: number) =>
    cap.measure === "cost" ? dollars(value) : `${value.toLocaleString("en-US")} tokens`;
  const state = cap.reached
    ? "  REACHED"
    : cap.unpricedRuns > 0
      ? `  not enforced: ${cap.unpricedRuns} unpriced run${cap.unpricedRuns === 1 ? "" : "s"}`
      : "";
  return `  ${cap.key.padEnd(34)}  ${amount(cap.spent)} of ${amount(cap.limit)}${state}`;
}

export function spendCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const report = yield* readSpend(Date.now()).pipe(Effect.either);
    if (report._tag === "Left") {
      failEnvelope(options.json, `Could not read the spend ledger: ${report.left.message}`);
      return;
    }
    const spend = report.right;
    const caps = capStatuses(appConfig.daemon, spend);
    const capLines =
      caps.length === 0
        ? [
            "",
            "Caps: none (unlimited). Set them with `jazz` > Update configuration > Spend Limits.",
          ]
        : ["", "Caps (unattended runs only; chat never counts)", ...caps.map(describeCap)];
    const text = [
      `Today (${spend.day}):       ${describeTotals(spend.today.total)}`,
      `This month (${spend.monthKey}): ${describeTotals(spend.month.total)}`,
      `Unattended today:         ${describeTotals(spend.today.unattended)}`,
      ...capLines,
      ...breakdown("This month by source", sourceEntries(spend.month)),
      ...breakdown("This month by agent", Object.entries(spend.month.byAgent)),
      ...(spend.unreadableLines > 0
        ? ["", `${spend.unreadableLines} ledger line(s) could not be read and are not counted.`]
        : []),
    ].join("\n");
    emitEnvelope(
      options.json,
      {
        ok: true,
        day: spend.day,
        month: spend.monthKey,
        today: spend.today,
        thisMonth: spend.month,
        caps,
        unreadableLines: spend.unreadableLines,
      },
      text,
    );
  });
}
