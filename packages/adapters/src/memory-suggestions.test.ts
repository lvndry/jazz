import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type {
  FactSuggestionInput,
  LessonProposalInput,
} from "@jazz/core/interfaces/memory-suggestion";
import { quotedSentenceKeys } from "@jazz/core/memory/source-trust";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { MemoryServiceImpl } from "./memory-service";
import { MAX_PENDING_SUGGESTIONS } from "./memory-suggestions";

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
    expect(
      (await runEffect(service.pendingSuggestions())).map((proposal) =>
        proposal.kind === "lesson" ? proposal.rule : undefined,
      ),
    ).toEqual([priorArt.rule]);
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
    expect(await runEffect(service.pendingSuggestions())).toHaveLength(1);
  });

  test("a full queue refuses a new proposal instead of dropping a waiting one", async () => {
    const service = makeService();
    for (let index = 0; index < MAX_PENDING_SUGGESTIONS; index += 1) {
      await runEffect(
        service.proposeLesson({ ...priorArt, rule: `Rule number ${String(index)}.` }),
      );
    }
    const overflow = await runEffect(
      service.proposeLesson({ ...priorArt, rule: "One more rule." }),
    );

    expect(overflow.success).toBe(false);
    const pending = await runEffect(service.pendingSuggestions());
    expect(pending).toHaveLength(MAX_PENDING_SUGGESTIONS);
    expect(pending[0]).toMatchObject({ kind: "lesson", rule: "Rule number 0." });
  });

  test("accepting saves the rule under its situation as a lesson and dequeues it", async () => {
    const service = makeService();
    const proposed = await runEffect(service.proposeLesson(priorArt));
    if (!proposed.success) {
      throw new Error(proposed.message);
    }
    const accepted = await runEffect(service.acceptSuggestion(proposed.suggestion.id));

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
    expect(await runEffect(service.pendingSuggestions())).toEqual([]);
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

    expect((await runEffect(service.acceptSuggestion(proposed.suggestion.id))).success).toBe(false);
    expect(await runEffect(service.pendingSuggestions())).toHaveLength(1);
  });

  test("rejecting drops the proposal without touching memory", async () => {
    const service = makeService();
    const proposed = await runEffect(service.proposeLesson(priorArt));
    if (!proposed.success) {
      throw new Error(proposed.message);
    }

    expect((await runEffect(service.rejectSuggestion(proposed.suggestion.id))).success).toBe(true);
    expect(await runEffect(service.pendingSuggestions())).toEqual([]);
    expect((await runEffect(service.rejectSuggestion(proposed.suggestion.id))).success).toBe(false);
  });

  test("an unreadable queue lists as empty but refuses new proposals", async () => {
    const service = makeService();
    fs.writeFileSync(path.join(tmpDir, ".pending-memory.json"), "{not json");

    expect(await runEffect(service.pendingSuggestions())).toEqual([]);
    const outcome = await runEffect(service.proposeLesson(priorArt).pipe(Effect.either));
    expect(outcome._tag).toBe("Left");
  });

  test("an accept and a reject racing on one lesson never both succeed", async () => {
    for (let round = 0; round < 5; round += 1) {
      const service = makeService();
      const proposed = await runEffect(
        service.proposeLesson({ ...priorArt, subject: `prior art ${String(round)}` }),
      );
      if (!proposed.success) {
        throw new Error(proposed.message);
      }
      const [accepted, rejected] = await Promise.all([
        runEffect(service.acceptSuggestion(proposed.suggestion.id)),
        runEffect(service.rejectSuggestion(proposed.suggestion.id)),
      ]);
      const saved = await runEffect(
        service.view(`personal/when/planning-a-new-project/prior-art-${String(round)}.md`),
      );

      expect(accepted.success !== rejected.success).toBe(true);
      expect(saved.kind === "file").toBe(accepted.success);
      expect(await runEffect(service.pendingSuggestions())).toEqual([]);
    }
  });

  test("stores proposal text without terminal control characters", async () => {
    const service = makeService();
    await runEffect(
      service.proposeLesson({
        ...priorArt,
        rule: "Check first.\u001b[2J\u001b]8;;https://example.com\u0007 Then build.",
        mistake: "Skipped\nthe check.",
      }),
    );

    const [stored] = (await runEffect(service.pendingSuggestions())).filter(
      (suggestion) => suggestion.kind === "lesson",
    );
    // eslint-disable-next-line no-control-regex
    expect(stored?.rule).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(stored?.rule).toStartWith("Check first.");
    expect(stored?.mistake).toBe("Skipped the check.");
  });

  test("refuses a scope that cannot name a memory directory", async () => {
    const service = makeService();
    const outcome = await runEffect(service.proposeLesson({ ...priorArt, scope: "../outside" }));

    expect(outcome.success).toBe(false);
    expect(await runEffect(service.pendingSuggestions())).toEqual([]);
  });
});

const fruitPath = "personal/when/food/favorite-fruit.md";

function fruitSuggestion(change: FactSuggestionInput["change"]): FactSuggestionInput {
  return {
    change,
    quote: "My favorite fruit is mango.",
    quotedSentenceKeys: quotedSentenceKeys(
      { id: "user:1", text: "My favorite fruit is mango." },
      "My favorite fruit is mango.",
    ),
    proposedBy: "memory-extractor",
    conversationId: "conversation-1",
  };
}

describe("fact suggestions", () => {
  test("wait in the same queue as lessons and write nothing until accepted", async () => {
    const service = makeService();
    await runEffect(service.proposeLesson(priorArt));
    const suggested = await runEffect(
      service.suggestFact(
        fruitSuggestion({
          command: "create",
          path: fruitPath,
          content: 'The user said: "My favorite fruit is mango."\n',
        }),
      ),
    );

    expect(suggested.success).toBe(true);
    expect((await runEffect(service.pendingSuggestions())).map((item) => item.kind)).toEqual([
      "lesson",
      "fact",
    ]);
    expect((await runEffect(service.view(fruitPath))).kind).toBe("not_found");
  });

  test("the same write suggested twice is queued once", async () => {
    const service = makeService();
    const change = {
      command: "create",
      path: fruitPath,
      content: 'The user said: "My favorite fruit is mango."\n',
    } as const;
    const first = await runEffect(service.suggestFact(fruitSuggestion(change)));
    const second = await runEffect(service.suggestFact(fruitSuggestion(change)));

    expect(first.success && second.success && first.suggestion.id === second.suggestion.id).toBe(
      true,
    );
    expect(await runEffect(service.pendingSuggestions())).toHaveLength(1);
  });

  test("accepting a create writes it as an automatic entry and dequeues it", async () => {
    const service = makeService();
    const suggested = await runEffect(
      service.suggestFact(
        fruitSuggestion({
          command: "create",
          path: fruitPath,
          content: 'The user said: "My favorite fruit is mango."\n',
        }),
      ),
    );
    if (!suggested.success) {
      throw new Error(suggested.message);
    }
    const accepted = await runEffect(service.acceptSuggestion(suggested.suggestion.id));

    expect(accepted).toMatchObject({ success: true, path: fruitPath });
    const entry = await runEffect(service.view(fruitPath));
    expect(entry.kind === "file" ? entry.content : undefined).toBe(
      'The user said: "My favorite fruit is mango."\n',
    );
    expect((await runEffect(service.provenance(fruitPath)))?.origin).toBe("auto");
    expect(await runEffect(service.pendingSuggestions())).toEqual([]);
  });

  test("accepting an amendment after the entry changed fails and leaves it waiting", async () => {
    const service = makeService();
    await runEffect(
      service.create(fruitPath, 'The user said: "Banana."\n', { agentId: "agent-1" }),
    );
    const suggested = await runEffect(
      service.suggestFact(
        fruitSuggestion({
          command: "amend",
          path: fruitPath,
          previousContent: 'The user said: "Banana."\n',
          content: 'The user said: "My favorite fruit is mango."\n',
        }),
      ),
    );
    if (!suggested.success) {
      throw new Error(suggested.message);
    }
    await runEffect(
      service.strReplace(fruitPath, 'The user said: "Banana."\n', 'The user said: "Kiwi."\n', {
        agentId: "agent-1",
      }),
    );
    const accepted = await runEffect(service.acceptSuggestion(suggested.suggestion.id));

    expect(accepted.success).toBe(false);
    const entry = await runEffect(service.view(fruitPath));
    expect(entry.kind === "file" ? entry.content : undefined).toBe('The user said: "Kiwi."\n');
    expect(await runEffect(service.pendingSuggestions())).toHaveLength(1);
  });

  test("accepting an amendment against the unchanged entry replaces it", async () => {
    const service = makeService();
    await runEffect(
      service.create(fruitPath, 'The user said: "Banana."\n', { agentId: "agent-1" }),
    );
    const suggested = await runEffect(
      service.suggestFact(
        fruitSuggestion({
          command: "amend",
          path: fruitPath,
          previousContent: 'The user said: "Banana."\n',
          content: 'The user said: "My favorite fruit is mango."\n',
        }),
      ),
    );
    if (!suggested.success) {
      throw new Error(suggested.message);
    }

    expect((await runEffect(service.acceptSuggestion(suggested.suggestion.id))).success).toBe(true);
    const entry = await runEffect(service.view(fruitPath));
    expect(entry.kind === "file" ? entry.content : undefined).toBe(
      'The user said: "My favorite fruit is mango."\n',
    );
  });
});
