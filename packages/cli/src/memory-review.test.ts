/** Checklists of waiting suggestions: checked are saved, unchecked on that checklist dropped. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { MemoryServiceImpl } from "@jazz/adapters/memory-service";
import type { PromptChoice, TerminalService } from "@jazz/core/interfaces/terminal";
import { quotedSentenceKeys } from "@jazz/core/memory/source-trust";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, type FileSystem } from "effect";
import { REVIEW_PAGE_SIZE, reviewMemorySuggestions, suggestionChoices } from "./memory-review";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-review-test-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeService(): MemoryServiceImpl {
  return new MemoryServiceImpl({
    baseMemoryDirectory: directory,
    receiptsDirectory: path.join(directory, ".receipts"),
  });
}

const fruitPath = "personal/when/food/favorite-fruit.md";
const lessonPath = "personal/always/check-prior-art.md";

async function queueLessons(service: MemoryServiceImpl, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let lessonNumber = 1; lessonNumber <= count; lessonNumber += 1) {
    const lesson = await run(
      service.proposeLesson({
        scope: "personal",
        subject: `lesson ${String(lessonNumber)}`,
        topic: "always",
        rule: `Rule number ${String(lessonNumber)}.`,
        mistake: `Mistake number ${String(lessonNumber)}.`,
        proposedBy: "agent-1",
      }),
    );
    if (!lesson.success) {
      throw new Error(lesson.message);
    }
    ids.push(lesson.suggestion.id);
  }
  return ids;
}

async function queueBoth(service: MemoryServiceImpl): Promise<{ fact: string; lesson: string }> {
  const quote = "My favorite fruit is mango.";
  const fact = await run(
    service.suggestFact({
      change: { command: "create", path: fruitPath, content: `The user said: "${quote}"\n` },
      quote,
      quotedSentenceKeys: quotedSentenceKeys({ id: "user:1", text: quote }, quote),
      proposedBy: "memory-extractor",
    }),
  );
  const lesson = await run(
    service.proposeLesson({
      scope: "personal",
      subject: "check prior art",
      topic: "always",
      rule: "Check for existing tools before proposing a build.",
      mistake: "Proposed building a tool that already existed.",
      proposedBy: "agent-1",
    }),
  );
  if (!fact.success || !lesson.success) {
    throw new Error("could not queue suggestions");
  }
  return { fact: fact.suggestion.id, lesson: lesson.suggestion.id };
}

function fakeTerminal(options: {
  readonly interactive: boolean;
  readonly answer?: (
    choices: readonly PromptChoice<string>[],
    checklistIndex: number,
  ) => readonly string[] | undefined;
}): {
  terminal: TerminalService;
  logged: string[];
  asked: { message: string; values: readonly string[] }[];
} {
  const logged: string[] = [];
  const asked: { message: string; values: readonly string[] }[] = [];
  const terminal = {
    isInteractive: options.interactive,
    log: (message: unknown) =>
      Effect.sync(() => {
        logged.push(typeof message === "string" ? message : JSON.stringify(message));
        return undefined;
      }),
    warn: (message: string) =>
      Effect.sync(() => {
        logged.push(message);
      }),
    checkbox: (message: string, prompt: { choices: readonly (string | PromptChoice<string>)[] }) =>
      Effect.sync(() => {
        const choices = prompt.choices.filter(
          (choice): choice is PromptChoice<string> => typeof choice !== "string",
        );
        asked.push({ message, values: choices.map((choice) => choice.value) });
        return options.answer?.(choices, asked.length - 1);
      }),
  } as unknown as TerminalService;
  return { terminal, logged, asked };
}

describe("memory review", () => {
  test("saves the checked suggestions and drops the rest", async () => {
    const service = makeService();
    const ids = await queueBoth(service);
    const { terminal } = fakeTerminal({ interactive: true, answer: () => [ids.fact] });

    await run(reviewMemorySuggestions(terminal, service, "/memory"));

    expect((await run(service.view(fruitPath))).kind).toBe("file");
    expect((await run(service.view(lessonPath))).kind).toBe("not_found");
    expect(await run(service.pendingSuggestions())).toEqual([]);
  });

  test("escape decides nothing and leaves everything waiting", async () => {
    const service = makeService();
    await queueBoth(service);
    const { terminal } = fakeTerminal({ interactive: true, answer: () => undefined });

    await run(reviewMemorySuggestions(terminal, service, "/memory"));

    expect(await run(service.pendingSuggestions())).toHaveLength(2);
    expect((await run(service.view(fruitPath))).kind).toBe("not_found");
  });

  test("more than one window of suggestions is decided a window at a time", async () => {
    const service = makeService();
    const total = REVIEW_PAGE_SIZE + 2;
    const ids = await queueLessons(service, total);
    const lastId = ids[total - 1] ?? "";
    const { terminal, asked } = fakeTerminal({
      interactive: true,
      answer: (_choices, checklistIndex) => (checklistIndex === 1 ? [lastId] : []),
    });

    await run(reviewMemorySuggestions(terminal, service, "/memory"));

    expect(asked.map((checklist) => checklist.values)).toEqual([
      ids.slice(0, REVIEW_PAGE_SIZE),
      ids.slice(REVIEW_PAGE_SIZE),
    ]);
    expect(asked[0]?.message).toContain(`1–${String(REVIEW_PAGE_SIZE)} of ${String(total)}`);
    expect(await run(service.pendingSuggestions())).toEqual([]);
    expect((await run(service.view(`personal/always/lesson-${String(total)}.md`))).kind).toBe(
      "file",
    );
  });

  test("escape on a later window keeps it and every window after it waiting", async () => {
    const service = makeService();
    const total = REVIEW_PAGE_SIZE * 2 + 1;
    const ids = await queueLessons(service, total);
    const { terminal, logged, asked } = fakeTerminal({
      interactive: true,
      answer: (_choices, checklistIndex) => (checklistIndex === 0 ? [] : undefined),
    });

    await run(reviewMemorySuggestions(terminal, service, "/memory"));

    expect(asked).toHaveLength(2);
    const pending = await run(service.pendingSuggestions());
    expect(pending.map((suggestion) => suggestion.id)).toEqual(ids.slice(REVIEW_PAGE_SIZE));
    expect(
      logged.some(
        (line) => line.includes("waiting") && line.includes(String(total - REVIEW_PAGE_SIZE)),
      ),
    ).toBe(true);
  });

  test("a terminal that cannot prompt only lists them", async () => {
    const service = makeService();
    await queueBoth(service);
    let asked = false;
    const { terminal, logged } = fakeTerminal({
      interactive: false,
      answer: () => {
        asked = true;
        return [];
      },
    });

    await run(reviewMemorySuggestions(terminal, service, "jazz memory"));

    expect(asked).toBe(false);
    expect(logged.some((line) => line.includes("jazz memory accept <id>"))).toBe(true);
    expect(await run(service.pendingSuggestions())).toHaveLength(2);
  });

  test("a kept suggestion that cannot be written stays waiting and is reported", async () => {
    const service = makeService();
    const ids = await queueBoth(service);
    await run(service.create(fruitPath, 'The user said: "Banana."\n', { agentId: "agent-1" }));
    const { terminal, logged } = fakeTerminal({
      interactive: true,
      answer: () => [ids.fact, ids.lesson],
    });

    await run(reviewMemorySuggestions(terminal, service, "/memory"));

    const pending = await run(service.pendingSuggestions());
    expect(pending.map((suggestion) => suggestion.id)).toEqual([ids.fact]);
    expect(logged.some((line) => line.startsWith("Not applied, still waiting"))).toBe(true);
    expect((await run(service.view(lessonPath))).kind).toBe("file");
  });

  test("each choice reads as the quoted words or rule, its details in the preview", async () => {
    const service = makeService();
    await queueBoth(service);

    const choices = suggestionChoices(await run(service.pendingSuggestions()));
    const previewText = (choice: PromptChoice<string>) =>
      (choice.preview ?? []).map((line) => line.map((span) => span.text).join(""));

    expect(choices.map((choice) => [choice.name, choice.tag])).toEqual([
      ["My favorite fruit is mango.", "fact"],
      ["Check for existing tools before proposing a build.", "lesson"],
    ]);
    expect(choices.map(previewText)).toEqual([
      [`saves to: ${fruitPath}`],
      ["learned from: Proposed building a tool that already existed.", `saves to: ${lessonPath}`],
    ]);
  });

  test("a removal reads as the entry it drops and reports it as removed once kept", async () => {
    const service = makeService();
    const stalePath = "personal/when/food/fruit.md";
    const staleContent = 'The user said: "Banana."\n';
    await run(service.create(stalePath, staleContent, { agentId: "agent-1" }));
    const queued = await run(
      service.suggestRevision({
        change: { command: "delete", path: stalePath, previousContent: staleContent },
        reason: "favorite-fruit.md records the newer favorite.",
        proposedBy: "memory-learner",
      }),
    );
    if (!queued.success) {
      throw new Error(queued.message);
    }

    const [choice] = suggestionChoices(await run(service.pendingSuggestions()));
    expect([choice?.name, choice?.tag, choice?.tagTone]).toEqual(["Banana.", "remove", "warning"]);
    expect((choice?.preview ?? []).map((line) => line.map((span) => span.text).join(""))).toEqual([
      "why: favorite-fruit.md records the newer favorite.",
      `removes: ${stalePath}`,
    ]);

    const { terminal, logged } = fakeTerminal({
      interactive: true,
      answer: () => [queued.suggestion.id],
    });
    await run(reviewMemorySuggestions(terminal, service, "/memory"));

    expect((await run(service.view(stalePath))).kind).toBe("not_found");
    expect(logged.some((line) => line.includes("removed") && line.includes(stalePath))).toBe(true);
  });
});
