/** Verifies that chat review reminders follow backlog milestones without repeating each turn. */
import { NodeFileSystem } from "@effect/platform-node";
import { MemoryServiceTag, type MemoryService } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { partialFake } from "../test-support/partial-fake";
import { announcePendingSuggestions } from "./announce-pending-suggestions";

describe("pending memory suggestions announcement", () => {
  test("shows the count on opening and then only when another ten are waiting", async () => {
    const messages: string[] = [];
    let count = 9;
    const memoryService = partialFake<MemoryService>({
      pendingSuggestions: () => Effect.succeed(Array.from({ length: count })),
    });
    const terminal = partialFake<TerminalService>({
      info: (message) =>
        Effect.sync(() => {
          messages.push(message);
        }),
    });
    const announce = (priorCount?: number) =>
      Effect.runPromise(
        announcePendingSuggestions(
          priorCount === undefined ? {} : { onlyIfMoreThan: priorCount },
        ).pipe(
          Effect.provideService(MemoryServiceTag, memoryService),
          Effect.provideService(TerminalServiceTag, terminal),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

    let priorCount = await announce();
    expect(messages).toEqual(["9 memory suggestions wait for review: /memory review"]);

    count = 10;
    priorCount = await announce(priorCount);
    count = 19;
    priorCount = await announce(priorCount);
    count = 21;
    priorCount = await announce(priorCount);
    count = 8;
    priorCount = await announce(priorCount);
    count = 10;
    await announce(priorCount);

    expect(messages).toEqual([
      "9 memory suggestions wait for review: /memory review",
      "10 memory suggestions wait for review: /memory review",
      "21 memory suggestions wait for review: /memory review",
      "10 memory suggestions wait for review: /memory review",
    ]);
  });
});
