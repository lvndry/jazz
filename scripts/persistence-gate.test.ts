import { CONVERSATION_LOG_VERSION } from "@jazz/adapters/history/conversation-log";
import { describe, expect, test } from "bun:test";
import { runGate } from "./gen-persistence-snapshots";
import {
  evaluateStore,
  hashDeclarations,
  renderSnapshot,
  SnapshotSchema,
  type Acknowledgement,
  type Snapshot,
  type StoreDeclarations,
  type StoreShape,
  type StoreVersion,
} from "./persistence-gate";
import { PERSISTED_STORES } from "./persistence-registry";
import { readVersion } from "./persistence-shape";

const STORE = "example";
const VERSION_SOURCE = "EXAMPLE_VERSION in example.ts";

function shapeOf(version: StoreVersion, field: string): StoreShape {
  const declarations: StoreDeclarations = {
    "example.ts#Example": [`interface Example {`, `  readonly ${field}: string;`, `}`],
  };
  return { version, shape: hashDeclarations(declarations), declarations };
}

function snapshotOf(shape: StoreShape): Snapshot {
  return SnapshotSchema.parse(JSON.parse(renderSnapshot(STORE, shape)));
}

function evaluate(
  live: StoreShape,
  snapshot: Snapshot | undefined,
  acknowledgements: readonly Acknowledgement[] = [],
) {
  return evaluateStore({
    store: STORE,
    versionSource: VERSION_SOURCE,
    live,
    snapshot,
    acknowledgements,
  });
}

describe("evaluateStore", () => {
  const baseline = shapeOf(2, "name");
  const changed = shapeOf(2, "title");

  test("an unchanged store is current", () => {
    expect(evaluate(baseline, snapshotOf(baseline)).status).toBe("current");
  });

  test("a changed shape at the same version without an acknowledgement fails", () => {
    const verdict = evaluate(changed, snapshotOf(baseline));
    expect(verdict.status).toBe("violation");
    expect(verdict).toMatchObject({ reason: "unacknowledged-change" });
    expect(verdict.status === "violation" && verdict.message).toContain("Example");
    expect(verdict.status === "violation" && verdict.message).toContain(VERSION_SOURCE);
    expect(verdict.status === "violation" && verdict.message).toContain(
      "persistence/changelog/example.json",
    );
  });

  test("a changed shape with a version bump passes and asks for a new snapshot", () => {
    const bumped = shapeOf(3, "title");
    expect(evaluate(bumped, snapshotOf(baseline))).toMatchObject({
      status: "regenerate",
      reason: "version-changed",
    });
  });

  test("a changed shape with a matching acknowledgement passes", () => {
    const acknowledgement: Acknowledgement = {
      shape: changed.shape,
      version: 2,
      description: "Renamed an optional field; readers ignore unknown keys.",
      readersOfOldFormatStillWork: true,
    };
    expect(evaluate(changed, snapshotOf(baseline), [acknowledgement])).toMatchObject({
      status: "regenerate",
      reason: "acknowledged",
    });
  });

  test("an acknowledgement for another shape does not cover this one", () => {
    const stale: Acknowledgement = {
      shape: shapeOf(2, "other").shape,
      version: 2,
      description: "Something else.",
      readersOfOldFormatStillWork: true,
    };
    expect(evaluate(changed, snapshotOf(baseline), [stale]).status).toBe("violation");
  });

  test("a versioned store cannot acknowledge a break without bumping", () => {
    const acknowledgement: Acknowledgement = {
      shape: changed.shape,
      version: 2,
      description: "Dropped a required field.",
      readersOfOldFormatStillWork: false,
    };
    expect(evaluate(changed, snapshotOf(baseline), [acknowledgement])).toMatchObject({
      status: "violation",
      reason: "incompatible-at-same-version",
    });
  });

  test("an unversioned store may acknowledge a break", () => {
    const before = shapeOf("unversioned", "name");
    const after = shapeOf("unversioned", "title");
    const acknowledgement: Acknowledgement = {
      shape: after.shape,
      version: "unversioned",
      description: "Dropped a required field; old files are quarantined.",
      readersOfOldFormatStillWork: false,
    };
    expect(evaluate(after, snapshotOf(before), [acknowledgement]).status).toBe("regenerate");
  });

  test("giving an unversioned store its first version counts as a bump", () => {
    expect(evaluate(shapeOf(1, "name"), snapshotOf(shapeOf("unversioned", "name")))).toMatchObject({
      status: "regenerate",
      reason: "version-changed",
    });
  });

  test("a version that goes down fails", () => {
    expect(evaluate(shapeOf(1, "name"), snapshotOf(shapeOf(2, "name")))).toMatchObject({
      status: "violation",
      reason: "version-decreased",
    });
  });

  test("a new store requires a snapshot", () => {
    const verdict = evaluate(baseline, undefined);
    expect(verdict).toMatchObject({ status: "regenerate", reason: "new-store" });
    expect(verdict.status === "regenerate" && verdict.message).toContain("gen:persistence");
  });

  test("a hand-edited snapshot fails", () => {
    const edited = { ...snapshotOf(baseline), shape: "000000000000" };
    expect(evaluate(baseline, edited)).toMatchObject({
      status: "violation",
      reason: "snapshot-edited",
    });
  });
});

describe("the checked-in persistence snapshots", () => {
  test("every registered store has a current snapshot and a clean verdict", () => {
    const report = runGate();
    const problems = report.stores
      .filter((entry) => entry.verdict.status !== "current")
      .map((entry) => (entry.verdict.status === "current" ? "" : entry.verdict.message));
    expect(problems).toEqual([]);
    expect(report.orphanFiles).toEqual([]);
  });

  test("store names are unique and a store has a gap exactly when it has no declarations", () => {
    const names = PERSISTED_STORES.map((store) => store.name);
    expect(new Set(names).size).toBe(names.length);
    for (const store of PERSISTED_STORES) {
      expect(store.declarations.length === 0).toBe(store.gap !== undefined);
    }
  });

  test("the registry reads the conversation log version from its constant", () => {
    const store = PERSISTED_STORES.find((candidate) => candidate.name === "conversation-log");
    expect(store).toBeDefined();
    expect(readVersion(store!.version)).toBe(CONVERSATION_LOG_VERSION);
  });
});
