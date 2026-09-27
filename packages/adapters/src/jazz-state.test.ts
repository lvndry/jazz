import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JazzStateServiceTag } from "@jazz/core/interfaces/jazz-state";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createJazzStateServiceLayer } from "./jazz-state";

function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "jazz-state-"));
}

function withState<A>(statePath: string, program: Effect.Effect<A, Error, never>) {
  return Effect.runPromise(
    program.pipe(Effect.provide(createJazzStateServiceLayer({ statePath }))) as Effect.Effect<
      A,
      Error
    >,
  );
}

describe("JazzStateService", () => {
  it("returns undefined for missing keys", async () => {
    const statePath = join(stateDirectory(), "state.json");
    const result = await withState(
      statePath,
      Effect.flatMap(JazzStateServiceTag, (state) => state.get("wizard.lastUsedAgentId")),
    );
    expect(result).toBeUndefined();
  });

  it("stores a value durably, private to its owner, with a schema version", async () => {
    const statePath = join(stateDirectory(), "state.json");
    await withState(
      statePath,
      Effect.flatMap(JazzStateServiceTag, (state) =>
        state.set("wizard.lastUsedAgentId", "agent-123"),
      ),
    );
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      schemaVersion: 1,
      wizard: { lastUsedAgentId: "agent-123" },
    });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("loads state written before schema versions", async () => {
    const statePath = join(stateDirectory(), "state.json");
    writeFileSync(statePath, JSON.stringify({ wizard: { lastUsedAgentId: "agent-456" } }));
    const result = await withState(
      statePath,
      Effect.flatMap(JazzStateServiceTag, (state) => state.get("wizard.lastUsedAgentId")),
    );
    expect(result).toBe("agent-456");
  });

  it("keeps a key another process set after this one started", async () => {
    const statePath = join(stateDirectory(), "state.json");
    await withState(
      statePath,
      Effect.gen(function* () {
        const state = yield* JazzStateServiceTag;
        writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, other: { key: "kept" } }));
        yield* state.set("wizard.lastUsedAgentId", "agent-1");
      }),
    );
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      schemaVersion: 1,
      other: { key: "kept" },
      wizard: { lastUsedAgentId: "agent-1" },
    });
  });

  it("quarantines a corrupt file instead of overwriting it", async () => {
    const directory = stateDirectory();
    const statePath = join(directory, "state.json");
    writeFileSync(statePath, "[not json");
    await withState(
      statePath,
      Effect.flatMap(JazzStateServiceTag, (state) =>
        state.set("wizard.lastUsedAgentId", "agent-789"),
      ),
    );
    const quarantined = readdirSync(directory).filter((name) => name.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(directory, quarantined[0] as string), "utf8")).toBe("[not json");
    expect(JSON.parse(readFileSync(statePath, "utf8")).wizard.lastUsedAgentId).toBe("agent-789");
  });

  it("reports a write failure to the caller", async () => {
    const directory = stateDirectory();
    const blockingFile = join(directory, "not-a-directory");
    writeFileSync(blockingFile, "");
    const error = await withState(
      join(blockingFile, "state.json"),
      Effect.flatMap(JazzStateServiceTag, (state) =>
        state.set("wizard.lastUsedAgentId", "agent-1"),
      ).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(Error);
  });

  it("ignores prototype-pollution paths", async () => {
    const statePath = join(stateDirectory(), "state.json");
    await withState(
      statePath,
      Effect.gen(function* () {
        const state = yield* JazzStateServiceTag;
        yield* state.set("__proto__.polluted", true);
        yield* state.set("constructor.prototype.polluted", true);
      }),
    );
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
