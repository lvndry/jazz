/** One checklist decides every waiting suggestion: checked are saved, the rest dropped. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { MemoryServiceImpl } from "@jazz/adapters/memory-service";
import type { PromptChoice, TerminalService } from "@jazz/core/interfaces/terminal";
import { quotedSentenceKeys } from "@jazz/core/memory/source-trust";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { reviewMemorySuggestions, suggestionChoices } from "./memory-review";

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
  readonly answer?: (choices: readonly PromptChoice<string>[]) => readonly string[] | undefined;
}): { terminal: TerminalService; logged: string[] } {
  const logged: string[] = [];
  const terminal = {
    isInteractive: options.interactive,
    log: (message: unknown) =>
      Effect.sync(() => {
        logged.push(String(message));
        return undefined;
      }),
    warn: (message: string) =>
      Effect.sync(() => {
        logged.push(message);
      }),
    checkbox: (_message: string, prompt: { choices: readonly (string | PromptChoice<string>)[] }) =>
      Effect.sync(() =>
        options.answer?.(
          prompt.choices.filter(
            (choice): choice is PromptChoice<string> => typeof choice !== "string",
          ),
        ),
      ),
  } as unknown as TerminalService;
  return { terminal, logged };
}

describe("memory review", () => {
  test("saves the checked suggestions and drops the rest in one decision", async () => {
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
    expect(logged.some((line) => line.startsWith("Not saved, still waiting"))).toBe(true);
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
});
