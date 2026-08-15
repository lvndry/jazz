/**
 * Daily usage tracking (runs, tokens, cost) per calendar day, used for the
 * `/status` report and the optional daily spend cap. `dataDir` is Jazz's home.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DailyUsage {
  costUSD: number;
  tokens: number;
  runs: number;
}

function usagePath(dataDir: string): string {
  return join(dataDir, "dc-usage.json");
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readUsage(dataDir: string): Record<string, DailyUsage> {
  try {
    const path = usagePath(dataDir);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, DailyUsage>;
    }
  } catch {
    // ignore — treat as empty
  }
  return {};
}

export function todayUsage(dataDir: string): DailyUsage {
  return readUsage(dataDir)[todayKey()] ?? { costUSD: 0, tokens: 0, runs: 0 };
}

export function recordUsage(dataDir: string, costUSD: number, tokens: number): void {
  const usage = readUsage(dataDir);
  const key = todayKey();
  const day = usage[key] ?? { costUSD: 0, tokens: 0, runs: 0 };
  usage[key] = {
    costUSD: day.costUSD + costUSD,
    tokens: day.tokens + tokens,
    runs: day.runs + 1,
  };
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const date of Object.keys(usage)) {
    if (date < cutoff) delete usage[date];
  }
  try {
    writeFileSync(usagePath(dataDir), `${JSON.stringify(usage, null, 2)}\n`);
  } catch (error) {
    console.error(`Failed to write usage: ${String(error)}`);
  }
}
