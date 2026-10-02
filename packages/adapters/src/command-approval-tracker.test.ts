import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  loadCommandApprovals,
  saveCommandApprovals,
  type CommandApprovals,
} from "./command-approval-tracker";

let directory: string;

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "jazz-approvals-"));
  process.env["JAZZ_HOME"] = directory;
});

afterEach(async () => {
  delete process.env["JAZZ_HOME"];
  await rm(directory, { recursive: true, force: true });
});

describe("command approvals on disk", () => {
  it("stamps the approvals file with a schema version on save", async () => {
    await run(
      saveCommandApprovals({
        "git push": { sessionCount: 1, lastSessionId: "s", nextPromptAt: 0 },
      }),
    );
    const record = JSON.parse(
      await readFile(path.join(directory, "command-approvals.json"), "utf8"),
    );
    expect(record.schemaVersion).toBe(1);
    expect(record["git push"]).toEqual({ sessionCount: 1, lastSessionId: "s", nextPromptAt: 0 });
  });

  it("reads an approvals file written before versioning and re-stamps it on the next save", async () => {
    await writeFile(
      path.join(directory, "command-approvals.json"),
      JSON.stringify({ "git pull": { sessionCount: 3, lastSessionId: "old", nextPromptAt: 5 } }),
    );
    const loaded = await run<CommandApprovals, Error>(loadCommandApprovals());
    expect(loaded["git pull"]).toEqual({ sessionCount: 3, lastSessionId: "old", nextPromptAt: 5 });

    await run(
      saveCommandApprovals({
        ...loaded,
        "git pull": { sessionCount: 4, lastSessionId: "new", nextPromptAt: 9 },
      }),
    );
    const record = JSON.parse(
      await readFile(path.join(directory, "command-approvals.json"), "utf8"),
    );
    expect(record.schemaVersion).toBe(1);
    expect(record["git pull"]).toEqual({ sessionCount: 4, lastSessionId: "new", nextPromptAt: 9 });
  });
});
