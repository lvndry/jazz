/**
 * Exercises the receipt boundary with isolated storage: scope-eligible unseen
 * memories, exact delivered bytes, pending requests, idempotency, erasure, and
 * epoch recovery. These tests deliberately do not infer whether a memory helped.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { MemoryEntrySnapshot } from "@/core/interfaces/memory-service";
import type { ChatMessage, MemoryDelivery } from "@/core/types/message";
import { sha256Hex } from "@/core/utils/hash";
import {
  INITIAL_RECEIPT_EPOCH,
  MAX_RECEIPTS_PER_ENTRY,
  RECEIPT_WRITES_BETWEEN_PRUNES,
  beginMemoryOpportunities,
  completeMemoryOpportunities,
  eraseMemoryOpportunityReceiptsForScope,
  readMemoryOpportunityReceipts,
  readMemoryReceiptEpoch,
  type MemoryOpportunityRequest,
} from "./memory-opportunity-receipts";

function run<A>(effect: Effect.Effect<A, Error, FileSystem.FileSystem>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

function snapshotOf(
  summary: string,
  entryPath: string,
  topic: string | undefined,
): MemoryEntrySnapshot {
  return {
    entryId: randomUUID(),
    entryContentHash: sha256Hex(summary),
    receiptEpoch: INITIAL_RECEIPT_EPOCH,
    path: entryPath,
    scope: "personal",
    topic,
    summary,
  };
}

function deliveryOf(entry: MemoryEntrySnapshot, toolContent: string): MemoryDelivery {
  return {
    path: entry.path,
    shownContentHash: sha256Hex(entry.summary),
    complete: true,
    messageContentHash: sha256Hex(toolContent),
  };
}

describe("memory opportunity receipts", () => {
  let receiptsDirectory: string;
  beforeEach(async () => {
    receiptsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-memory-receipts-"));
  });
  afterEach(async () => {
    await fs.rm(receiptsDirectory, { recursive: true, force: true });
  });

  function receiptsFor(entry: MemoryEntrySnapshot) {
    return run(readMemoryOpportunityReceipts("personal", entry.entryId, 5, receiptsDirectory));
  }

  test("records eligible unseen entries and only exact model-delivered exposures", async () => {
    const standing = snapshotOf("Prefer concise replies", "personal/always/style.md", undefined);
    const conditional = snapshotOf(
      "My favorite fruit is banana",
      "personal/when/shopping/fruit.md",
      "shopping",
    );
    const unseen = snapshotOf("Use metric units", "personal/when/cooking/units.md", "cooking");
    const toolContent = "     1\tMy favorite fruit is banana";
    const messages: ChatMessage[] = [
      { role: "system", content: "## Preferences\n- [personal] Prefer concise replies" },
      { role: "user", content: "Shopping list" },
      {
        role: "tool",
        name: "view_memory",
        tool_call_id: "call-1",
        content: toolContent,
        memoryDelivery: deliveryOf(conditional, toolContent),
      },
    ];
    const tickets = await run(
      beginMemoryOpportunities({
        runId: "run-7",
        iteration: 1,
        entries: [standing, conditional, unseen],
        messages,
        receiptsDirectory,
      }),
    );
    expect(tickets).toHaveLength(3);
    expect((await receiptsFor(unseen))[0]?.status).toBe("pending");

    await run(completeMemoryOpportunities(tickets, messages));
    const standingReceipt = (await receiptsFor(standing))[0];
    const viewedReceipt = (await receiptsFor(conditional))[0];
    const unseenReceipt = (await receiptsFor(unseen))[0];
    expect(standingReceipt?.exposures.map((exposure) => exposure.kind)).toEqual(["injected"]);
    expect(viewedReceipt?.exposures).toEqual([
      expect.objectContaining({
        kind: "viewed",
        shownContentHash: conditional.entryContentHash,
        complete: true,
      }),
    ]);
    expect(unseenReceipt?.status).toBe("completed");
    expect(unseenReceipt?.eligibility).toBe("eligible");
    expect(unseenReceipt?.exposures).toEqual([]);

    const stored = await fs.readFile(
      path.join(
        receiptsDirectory,
        "personal",
        conditional.entryId,
        `${viewedReceipt?.receiptId}.json`,
      ),
      "utf8",
    );
    expect(stored).not.toContain("banana");
    expect(stored).not.toContain("Shopping list");
  });

  test("does not count cleared or altered tool results and erases receipts on forget", async () => {
    const entry = snapshotOf("banana", "personal/when/shopping/fruit.md", "shopping");
    const messages: ChatMessage[] = [
      { role: "system", content: "plain" },
      {
        role: "tool",
        name: "view_memory",
        content: "[cleared]",
        cleared: true,
        memoryDelivery: deliveryOf(entry, "[cleared]"),
      },
      {
        role: "tool",
        name: "view_memory",
        content: "edited after delivery",
        memoryDelivery: deliveryOf(entry, "original bytes"),
      },
    ];
    const request: MemoryOpportunityRequest = {
      runId: "run-8",
      iteration: 1,
      entries: [entry],
      messages,
      receiptsDirectory,
    };
    const first = await run(beginMemoryOpportunities(request));
    const second = await run(beginMemoryOpportunities(request));
    expect(first[0]?.receipt.receiptId).toBe(second[0]?.receipt.receiptId);

    await run(completeMemoryOpportunities(first, messages));
    expect(await receiptsFor(entry)).toHaveLength(1);
    expect((await receiptsFor(entry))[0]?.exposures).toEqual([]);

    await run(beginMemoryOpportunities(request));
    expect((await receiptsFor(entry))[0]?.status).toBe("completed");

    await run(eraseMemoryOpportunityReceiptsForScope("personal", receiptsDirectory));
    expect(await receiptsFor(entry)).toEqual([]);
  });

  test("writes nothing when there is no memory to record", async () => {
    const tickets = await run(
      beginMemoryOpportunities({
        runId: "empty",
        iteration: 0,
        entries: [],
        messages: [{ role: "user", content: "hello" }],
        receiptsDirectory,
      }),
    );
    expect(tickets).toEqual([]);
    expect(await fs.readdir(receiptsDirectory)).toEqual([]);
  });

  test("marks conditional memory ineligible when view_memory was not offered", async () => {
    const entry = snapshotOf("banana", "personal/when/food/fruit.md", "food");
    const tickets = await run(
      beginMemoryOpportunities({
        runId: "no-tool",
        iteration: 0,
        entries: [entry],
        messages: [{ role: "user", content: "shopping" }],
        receiptsDirectory,
        viewMemoryOffered: false,
      }),
    );
    expect(tickets[0]?.receipt.eligibility).toBe("ineligible");
    expect(tickets[0]?.receipt.eligibilityEvidence).toBe("view_memory_not_offered");
  });

  test("an in-flight request cannot restore a receipt after forgetting", async () => {
    const entry = snapshotOf("banana", "personal/when/food/fruit.md", "food");
    const messages: ChatMessage[] = [{ role: "user", content: "shopping" }];
    const request: MemoryOpportunityRequest = {
      runId: "in-flight",
      iteration: 0,
      entries: [entry],
      messages,
      receiptsDirectory,
    };
    const tickets = await run(beginMemoryOpportunities(request));
    await run(eraseMemoryOpportunityReceiptsForScope("personal", receiptsDirectory));
    await run(completeMemoryOpportunities(tickets, messages));
    await run(beginMemoryOpportunities(request));
    expect(await receiptsFor(entry)).toEqual([]);
    expect(await run(readMemoryReceiptEpoch("personal", receiptsDirectory))).not.toBe(
      INITIAL_RECEIPT_EPOCH,
    );
  });

  test("replaces an unreadable epoch instead of disabling receipts for the scope", async () => {
    const scopeDirectory = path.join(receiptsDirectory, "personal");
    await fs.mkdir(scopeDirectory, { recursive: true });
    await fs.writeFile(path.join(scopeDirectory, ".epoch"), "not an epoch\n");

    const epoch = await run(readMemoryReceiptEpoch("personal", receiptsDirectory));
    expect(epoch).toMatch(/^[a-f0-9-]{36}$/);
    expect(await run(readMemoryReceiptEpoch("personal", receiptsDirectory))).toBe(epoch);
    const names = await fs.readdir(scopeDirectory);
    expect(names.some((name) => name.startsWith(".epoch.corrupt-"))).toBe(true);
  });

  test("keeps an entry's receipts bounded", async () => {
    const entry = snapshotOf("banana", "personal/when/food/fruit.md", "food");
    for (let iteration = 0; iteration < MAX_RECEIPTS_PER_ENTRY + 40; iteration++) {
      await run(
        beginMemoryOpportunities({
          runId: "long-run",
          iteration,
          entries: [entry],
          messages: [{ role: "user", content: `turn ${iteration}` }],
          receiptsDirectory,
        }),
      );
    }
    const names = await fs.readdir(path.join(receiptsDirectory, "personal", entry.entryId));
    const receiptFiles = names.filter((name) => name.endsWith(".json"));
    expect(receiptFiles.length).toBeLessThanOrEqual(
      MAX_RECEIPTS_PER_ENTRY + RECEIPT_WRITES_BETWEEN_PRUNES,
    );
    expect(receiptFiles.length).toBeGreaterThanOrEqual(MAX_RECEIPTS_PER_ENTRY);
  });
});
