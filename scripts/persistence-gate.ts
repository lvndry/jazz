/**
 * The decision behind `bun run verify:persistence`, as pure functions.
 *
 * A store's shape is the printed text of the declarations that define what it stores. The
 * checked-in snapshot is the baseline; the live shape is what the source says now. A shape that
 * moved must travel with a version change (the store's format version went up, so older readers
 * refuse it) or with a reviewed acknowledgement in the store's changelog that older readers still
 * work. Anything else is a violation, and every verdict names exactly what to do next.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export type StoreVersion = number | "unversioned";

export type StoreDeclarations = Readonly<Record<string, readonly string[]>>;

export interface StoreShape {
  readonly version: StoreVersion;
  readonly shape: string;
  readonly declarations: StoreDeclarations;
}

export const SNAPSHOT_SHAPE_LENGTH = 12;

const StoreVersionSchema = z.union([z.number().int().positive(), z.literal("unversioned")]);

export const AcknowledgementSchema = z.object({
  shape: z.string().length(SNAPSHOT_SHAPE_LENGTH),
  version: StoreVersionSchema,
  description: z.string().min(1),
  readersOfOldFormatStillWork: z.boolean(),
});

export type Acknowledgement = z.infer<typeof AcknowledgementSchema>;

export const ChangelogSchema = z.object({
  store: z.string().min(1),
  entries: z.array(AcknowledgementSchema),
});

export const SnapshotSchema = z.object({
  store: z.string().min(1),
  version: StoreVersionSchema,
  shape: z.string().length(SNAPSHOT_SHAPE_LENGTH),
  declarations: z.record(z.string(), z.array(z.string())),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export const CHANGELOG_DIRECTORY = "persistence/changelog";
export const SNAPSHOT_DIRECTORY = "persistence/snapshots";
export const MAINTAINER_PAGE = "docs/maintainers/persistence-changes.md";
export const GENERATE_COMMAND = "bun run gen:persistence";

export type Verdict =
  | { readonly status: "current" }
  | {
      readonly status: "regenerate";
      readonly reason: "new-store" | "version-changed" | "acknowledged";
      readonly message: string;
    }
  | {
      readonly status: "violation";
      readonly reason:
        | "unacknowledged-change"
        | "version-decreased"
        | "incompatible-at-same-version"
        | "snapshot-edited";
      readonly message: string;
    };

export interface StoreEvaluationInput {
  readonly store: string;
  /** Where the version lives, in words, for messages. */
  readonly versionSource: string;
  readonly live: StoreShape;
  readonly snapshot: Snapshot | undefined;
  readonly acknowledgements: readonly Acknowledgement[];
}

function sortedDeclarations(declarations: StoreDeclarations): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(declarations)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, lines]) => [name, [...lines]]),
  );
}

export function hashDeclarations(declarations: StoreDeclarations): string {
  return createHash("sha256")
    .update(JSON.stringify(sortedDeclarations(declarations)))
    .digest("hex")
    .slice(0, SNAPSHOT_SHAPE_LENGTH);
}

export function changedDeclarations(
  before: StoreDeclarations,
  after: StoreDeclarations,
): readonly string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    .sort();
}

function acknowledgementTemplate(live: StoreShape): string {
  return JSON.stringify({
    shape: live.shape,
    version: live.version,
    description: "<what changed, in one sentence>",
    readersOfOldFormatStillWork: true,
  });
}

function unacknowledgedChangeMessage(input: StoreEvaluationInput, snapshot: Snapshot): string {
  const { store, live } = input;
  const changed = changedDeclarations(snapshot.declarations, live.declarations);
  return [
    `persisted shape of "${store}" changed (${snapshot.shape} -> ${live.shape}) at version ${live.version}.`,
    `  changed declarations: ${changed.join(", ")}`,
    `  Do one of:`,
    `  1. The change breaks older readers: bump ${input.versionSource}, write an adjacent-version migration, add a regression test that reads a fixture of the previous version, then run \`${GENERATE_COMMAND}\`.`,
    `  2. Older readers still work (for example, a new optional field): append to "entries" in ${CHANGELOG_DIRECTORY}/${store}.json`,
    `       ${acknowledgementTemplate(live)}`,
    `     fill in the description, then run \`${GENERATE_COMMAND}\`.`,
    `  See ${MAINTAINER_PAGE}.`,
  ].join("\n");
}

/** What the gate says about one store, given its live shape, snapshot and acknowledgements. */
export function evaluateStore(input: StoreEvaluationInput): Verdict {
  const { store, live, snapshot, acknowledgements } = input;
  if (snapshot === undefined) {
    return {
      status: "regenerate",
      reason: "new-store",
      message: `"${store}" has no snapshot at ${SNAPSHOT_DIRECTORY}/${store}.json. Run \`${GENERATE_COMMAND}\` and commit the result.`,
    };
  }
  if (hashDeclarations(snapshot.declarations) !== snapshot.shape) {
    return {
      status: "violation",
      reason: "snapshot-edited",
      message: `${SNAPSHOT_DIRECTORY}/${store}.json does not match its own shape hash. Snapshots are generated: restore the file from git, change the source, and run \`${GENERATE_COMMAND}\`.`,
    };
  }
  const sameVersion = snapshot.version === live.version;
  if (sameVersion && snapshot.shape === live.shape) {
    return { status: "current" };
  }
  if (!sameVersion) {
    const decreased =
      typeof snapshot.version === "number" &&
      (live.version === "unversioned" || live.version < snapshot.version);
    if (decreased) {
      return {
        status: "violation",
        reason: "version-decreased",
        message: `"${store}" version went from ${snapshot.version} to ${live.version}. A format version only goes up: restore ${input.versionSource}.`,
      };
    }
    return {
      status: "regenerate",
      reason: "version-changed",
      message: `"${store}" is now at version ${live.version} (snapshot: ${snapshot.version}). Run \`${GENERATE_COMMAND}\` and commit the snapshot. Check that an adjacent-version migration and a previous-version fixture test exist.`,
    };
  }
  const acknowledgement = acknowledgements.find(
    (entry) => entry.shape === live.shape && entry.version === live.version,
  );
  if (acknowledgement === undefined) {
    return {
      status: "violation",
      reason: "unacknowledged-change",
      message: unacknowledgedChangeMessage(input, snapshot),
    };
  }
  if (live.version !== "unversioned" && !acknowledgement.readersOfOldFormatStillWork) {
    return {
      status: "violation",
      reason: "incompatible-at-same-version",
      message: `"${store}" is versioned, and its changelog says older readers break at version ${live.version}. Bump ${input.versionSource} and write the migration instead; then run \`${GENERATE_COMMAND}\`.`,
    };
  }
  return {
    status: "regenerate",
    reason: "acknowledged",
    message: `"${store}" changed shape with an acknowledgement. Run \`${GENERATE_COMMAND}\` and commit the snapshot.`,
  };
}

/** The checked-in text of a store's snapshot. */
export function renderSnapshot(store: string, live: StoreShape): string {
  const snapshot: Snapshot = {
    store,
    version: live.version,
    shape: live.shape,
    declarations: sortedDeclarations(live.declarations),
  };
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** The text of a changelog that has no entries yet. */
export function renderEmptyChangelog(store: string): string {
  return `${JSON.stringify({ store, entries: [] }, null, 2)}\n`;
}
