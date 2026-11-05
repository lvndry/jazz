/**
 * Generates `persistence/snapshots/<store>.json` for every store in
 * `persistence-registry.ts`, and checks them against the source.
 *
 * `--check` (what `bun run verify:persistence` runs) writes nothing: it fails when a snapshot is
 * missing or stale, or when a store's shape moved without a version change or a reviewed
 * acknowledgement in `persistence/changelog/<store>.json`. Without `--check` it writes the
 * snapshots the gate allows and refuses the rest, so regenerating never launders a change. See
 * `docs/maintainers/persistence-changes.md`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ChangelogSchema,
  CHANGELOG_DIRECTORY,
  evaluateStore,
  renderEmptyChangelog,
  renderSnapshot,
  SNAPSHOT_DIRECTORY,
  SnapshotSchema,
  type Acknowledgement,
  type Snapshot,
  type Verdict,
} from "./persistence-gate";
import { PERSISTED_STORES, type PersistedStore } from "./persistence-registry";
import { describeVersionSource, readLiveShape } from "./persistence-shape";

const REPOSITORY_ROOT = path.join(import.meta.dir, "..");

export interface StoreReport {
  readonly store: PersistedStore;
  readonly verdict: Verdict;
}

export interface GateReport {
  readonly stores: readonly StoreReport[];
  readonly orphanFiles: readonly string[];
}

function absolute(relativePath: string): string {
  return path.join(REPOSITORY_ROOT, relativePath);
}

function snapshotPath(name: string): string {
  return `${SNAPSHOT_DIRECTORY}/${name}.json`;
}

function changelogPath(name: string): string {
  return `${CHANGELOG_DIRECTORY}/${name}.json`;
}

function readSnapshot(name: string): Snapshot | undefined {
  const file = absolute(snapshotPath(name));
  if (!existsSync(file)) {
    return undefined;
  }
  return SnapshotSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
}

function readAcknowledgements(name: string): readonly Acknowledgement[] {
  const file = absolute(changelogPath(name));
  if (!existsSync(file)) {
    return [];
  }
  return ChangelogSchema.parse(JSON.parse(readFileSync(file, "utf-8"))).entries;
}

function findOrphanFiles(): readonly string[] {
  const registered = new Set(PERSISTED_STORES.map((store) => store.name));
  const orphans: string[] = [];
  for (const directory of [SNAPSHOT_DIRECTORY, CHANGELOG_DIRECTORY]) {
    if (!existsSync(absolute(directory))) {
      continue;
    }
    for (const entry of readdirSync(absolute(directory))) {
      if (!registered.has(entry.replace(/\.json$/, ""))) {
        orphans.push(`${directory}/${entry}`);
      }
    }
  }
  return orphans;
}

export function runGate(): GateReport {
  const stores = PERSISTED_STORES.map((store): StoreReport => {
    const verdict = evaluateStore({
      store: store.name,
      versionSource: describeVersionSource(store.version),
      live: readLiveShape(store),
      snapshot: readSnapshot(store.name),
      acknowledgements: readAcknowledgements(store.name),
    });
    return { store, verdict };
  });
  return { stores, orphanFiles: findOrphanFiles() };
}

function writeStore(store: PersistedStore): void {
  mkdirSync(absolute(SNAPSHOT_DIRECTORY), { recursive: true });
  mkdirSync(absolute(CHANGELOG_DIRECTORY), { recursive: true });
  writeFileSync(
    absolute(snapshotPath(store.name)),
    renderSnapshot(store.name, readLiveShape(store)),
  );
  if (!existsSync(absolute(changelogPath(store.name)))) {
    writeFileSync(absolute(changelogPath(store.name)), renderEmptyChangelog(store.name));
  }
}

function printReport(report: GateReport): void {
  const gaps = report.stores.filter((entry) => entry.store.gap !== undefined);
  console.log(
    `${report.stores.length} persisted stores, ${gaps.length} without a mechanical shape (gaps):`,
  );
  for (const { store } of gaps) {
    console.log(`  - ${store.name}: ${store.gap}`);
  }
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const report = runGate();
  const failures: string[] = [];

  for (const { store, verdict } of report.stores) {
    if (verdict.status === "violation") {
      failures.push(verdict.message);
      continue;
    }
    if (verdict.status === "current") {
      continue;
    }
    if (checkOnly) {
      failures.push(verdict.message);
    } else {
      writeStore(store);
      console.log(`wrote ${snapshotPath(store.name)} (${verdict.reason})`);
    }
  }
  for (const orphan of report.orphanFiles) {
    failures.push(`${orphan} belongs to no store in scripts/persistence-registry.ts. Delete it.`);
  }

  printReport(report);
  if (failures.length > 0) {
    console.error(`\nPersistence gate failed:\n`);
    console.error(failures.join("\n\n"));
    process.exit(1);
  }
  console.log(checkOnly ? "Persistence snapshots are current." : "Persistence snapshots written.");
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  main();
}
