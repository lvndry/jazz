/**
 * Pure budget evaluation for the pull-request performance lane. Takes parsed
 * benchmark rows and measured binary sizes, returns one actionable message per
 * exceeded budget. No timing, I/O or environment access lives here.
 */
import { CI_TIME_SCALE, type LatencyBudget, type SizeBudget } from "./pr-perf-budgets";

export interface MeasuredRow {
  readonly suite: string;
  readonly name: string;
  readonly p95Ms: number;
}

export interface BudgetFailure {
  readonly subject: string;
  readonly message: string;
}

export function effectiveLatencyBudgetMs(budget: LatencyBudget, ciScale: boolean): number {
  return budget.referenceP95Ms * (ciScale ? CI_TIME_SCALE : 1);
}

function overBy(measured: number, limit: number): string {
  const excess = measured - limit;
  return `+${excess.toFixed(2)} (+${((excess / limit) * 100).toFixed(0)}%)`;
}

export function latencyFailures(
  rows: readonly MeasuredRow[],
  budgets: readonly LatencyBudget[],
  ciScale: boolean,
): readonly BudgetFailure[] {
  const failures: BudgetFailure[] = [];
  for (const budget of budgets) {
    const subject = `${budget.suite}/${budget.name}`;
    const row = rows.find(
      (candidate) => candidate.suite === budget.suite && candidate.name === budget.name,
    );
    if (row === undefined) {
      failures.push({ subject, message: `${subject}: budgeted workload missing from the report` });
      continue;
    }
    const limit = effectiveLatencyBudgetMs(budget, ciScale);
    if (!(row.p95Ms <= limit)) {
      failures.push({
        subject,
        message: `${subject}: p95 ${row.p95Ms.toFixed(2)} ms exceeds budget ${limit} ms by ${overBy(row.p95Ms, limit)} ms`,
      });
    }
  }
  return failures;
}

export function sizeFailures(
  measured: { readonly binaryBytes: number; readonly gzipBytes: number },
  budget: SizeBudget,
): readonly BudgetFailure[] {
  const failures: BudgetFailure[] = [];
  const checks = [
    { subject: "release binary", value: measured.binaryBytes, limit: budget.binaryBytes },
    { subject: "gzip download", value: measured.gzipBytes, limit: budget.gzipBytes },
  ];
  for (const check of checks) {
    if (!(check.value <= check.limit)) {
      failures.push({
        subject: check.subject,
        message: `${check.subject}: ${check.value} bytes exceeds budget ${check.limit} bytes by ${overBy(check.value, check.limit)} bytes`,
      });
    }
  }
  return failures;
}
