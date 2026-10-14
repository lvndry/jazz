import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { LessonProposalInput } from "@jazz/core/interfaces/lesson-proposal";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { MAX_PENDING_LESSONS } from "./lesson-proposals";
import { MemoryServiceImpl } from "./memory-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-lessons-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeService(): MemoryServiceImpl {
  return new MemoryServiceImpl({
    baseMemoryDirectory: tmpDir,
    receiptsDirectory: path.join(tmpDir, ".memory-receipts"),
  });
}

const priorArt: LessonProposalInput = {
  subject: "prior art before building",
  rule: "Search for existing products before proposing to build a new one.",
  mistake: "Planned a reader app without noticing an open-source one already did it.",
  topic: "planning-a-new-project",
  scope: "personal",
  proposedBy: "agent-1",
  conversationId: "conversation-1",
};

describe("lesson proposals", () => {
  test("a proposal waits in the queue and writes nothing to memory", async () => {
    const service = makeService();
    const outcome = await runEffect(service.proposeLesson(priorArt));

    expect(outcome.success).toBe(true);
    expect((await runEffect(service.pendingLessons())).map((proposal) => proposal.rule)).toEqual([
      priorArt.rule,
    ]);
    const listing = await runEffect(service.view(""));
    expect(listing.kind === "directory" ? listing.entries : []).toEqual([]);
  });

  test("a reworded duplicate of a waiting rule is not queued twice", async () => {
    const service = makeService();
    await runEffect(service.proposeLesson(priorArt));
    const again = await runEffect(
      service.proposeLesson({
        ...priorArt,
        rule: "search for existing products, before proposing to build a new one",
      }),
    );

    expect(again.success).toBe(true);
    expect(await runEffect(service.pendingLessons())).toHaveLength(1);
  });

  test("a full queue refuses a new proposal instead of dropping a waiting one", async () => {
    const service = makeService();
    for (let index = 0; index < MAX_PENDING_LESSONS; index += 1) {
      await runEffect(
        service.proposeLesson({ ...priorArt, rule: `Rule number ${String(index)}.` }),
      );
    }
    const overflow = await runEffect(
      service.proposeLesson({ ...priorArt, rule: "One more rule." }),
    );

    expect(overflow.success).toBe(false);
    const pending = await runEffect(service.pendingLessons());
    expect(pending).toHaveLength(MAX_PENDING_LESSONS);
    expect(pending[0]?.rule).toBe("Rule number 0.");
  });

  test("accepting saves the rule under its situation as a lesson and dequeues it", async () => {
    const service = makeService();
    const proposed = await runEffect(service.proposeLesson(priorArt));
    if (!proposed.success) {
      throw new Error(proposed.message);
    }
    const accepted = await runEffect(service.acceptLesson(proposed.proposal.id));

    expect(accepted).toMatchObject({
      success: true,
      path: "personal/when/planning-a-new-project/prior-art-before-building.md",
    });
    const entry = await runEffect(
      service.view("personal/when/planning-a-new-project/prior-art-before-building.md"),
    );
    expect(entry.kind === "file" ? entry.content.split("\n")[0] : undefined).toBe(priorArt.rule);
    const provenance = await runEffect(
      service.provenance("personal/when/planning-a-new-project/prior-art-before-building.md"),
    );
    expect(provenance?.origin).toBe("lesson");
    expect(provenance?.failure).toEqual({
      kind: "correction",
      correctedBehavior: priorArt.mistake,
    });
    expect(await runEffect(service.pendingLessons())).toEqual([]);
  });

  test("accepting onto an existing entry fails and leaves the proposal waiting", async () => {
    const service = makeService();
    await runEffect(
      service.create(
        "personal/when/planning-a-new-project/prior-art-before-building.md",
        "Already here.\n",
        { agentId: "agent-1" },
      ),
    );
    const proposed = await runEffect(service.proposeLesson(priorArt));
    if (!proposed.success) {
      throw new Error(proposed.message);
    }

    expect((await runEffect(service.acceptLesson(proposed.proposal.id))).success).toBe(false);
    expect(await runEffect(service.pendingLessons())).toHaveLength(1);
  });

  test("rejecting drops the proposal without touching memory", async () => {
    const service = makeService();
    const proposed = await runEffect(service.proposeLesson(priorArt));
    if (!proposed.success) {
      throw new Error(proposed.message);
    }

    expect((await runEffect(service.rejectLesson(proposed.proposal.id))).success).toBe(true);
    expect(await runEffect(service.pendingLessons())).toEqual([]);
    expect((await runEffect(service.rejectLesson(proposed.proposal.id))).success).toBe(false);
  });

  test("an unreadable queue lists as empty but refuses new proposals", async () => {
    const service = makeService();
    fs.writeFileSync(path.join(tmpDir, ".pending-lessons.json"), "{not json");

    expect(await runEffect(service.pendingLessons())).toEqual([]);
    const outcome = await runEffect(service.proposeLesson(priorArt).pipe(Effect.either));
    expect(outcome._tag).toBe("Left");
  });
});
