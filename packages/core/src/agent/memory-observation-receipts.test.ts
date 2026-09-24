/**
 * Exercises the shadow receipt boundary with isolated storage: scope-eligible
 * unseen memories, exact delivered bytes, pending requests, idempotency, and
 * erasure. These tests deliberately do not infer whether a memory helped.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryEntryObservation } from "@/core/interfaces/memory-service";
import type { ChatMessage } from "@/core/types/message";
import {
  beginMemoryOpportunities,
  completeMemoryOpportunities,
  eraseMemoryOpportunityReceiptsForScope,
  readMemoryReceiptEpoch,
  readMemoryOpportunityReceipts,
} from "./memory-observation-receipts";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("memory observation receipts", () => {
  let homeDirectory: string;
  beforeEach(async () => {
    homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-memory-receipts-"));
  });
  afterEach(async () => {
    await fs.rm(homeDirectory, { recursive: true, force: true });
  });

  test("records eligible unseen entries and only exact model-delivered exposures", async () => {
    const standing: MemoryEntryObservation = {
      entryId: randomUUID(),
      entryVersion: hash("Prefer concise replies"),
      receiptEpoch: "0",
      path: "personal/always/style.md",
      scope: "personal",
      topic: undefined,
      summary: "Prefer concise replies",
    };
    const conditional: MemoryEntryObservation = {
      entryId: randomUUID(),
      entryVersion: hash("My favorite fruit is banana"),
      receiptEpoch: "0",
      path: "personal/when/shopping/fruit.md",
      scope: "personal",
      topic: "shopping",
      summary: "My favorite fruit is banana",
    };
    const unseen: MemoryEntryObservation = {
      entryId: randomUUID(),
      entryVersion: hash("Use metric units"),
      receiptEpoch: "0",
      path: "personal/when/cooking/units.md",
      scope: "personal",
      topic: "cooking",
      summary: "Use metric units",
    };
    const toolContent = "1\tMy favorite fruit is banana";
    const messages: ChatMessage[] = [
      { role: "system", content: "## Preferences\n- [personal] Prefer concise replies" },
      {
        role: "user",
        content: "Shopping list",
        memorySource: { id: "user:7", text: "Shopping list" },
      },
      {
        role: "tool",
        name: "view_memory",
        tool_call_id: "call-1",
        content: toolContent,
        memoryDelivery: {
          path: conditional.path,
          messageFingerprint: hash(toolContent),
          deliveredVersion: hash(toolContent),
          deliveredFingerprint: hash(toolContent),
        },
      },
    ];
    const tickets = await beginMemoryOpportunities({
      runId: "run-7",
      iteration: 1,
      entries: [standing, conditional, unseen],
      messages,
      homeDirectory,
    });
    expect(tickets).toHaveLength(3);
    expect(
      (await readMemoryOpportunityReceipts("personal", unseen.entryId, 5, homeDirectory))[0]
        ?.status,
    ).toBe("pending");
    await completeMemoryOpportunities(tickets, messages);
    const standingReceipt = (
      await readMemoryOpportunityReceipts("personal", standing.entryId, 5, homeDirectory)
    )[0];
    const viewedReceipt = (
      await readMemoryOpportunityReceipts("personal", conditional.entryId, 5, homeDirectory)
    )[0];
    const unseenReceipt = (
      await readMemoryOpportunityReceipts("personal", unseen.entryId, 5, homeDirectory)
    )[0];
    expect(standingReceipt?.exposures.map((item) => item.kind)).toEqual(["injected"]);
    expect(viewedReceipt?.exposures.map((item) => item.kind)).toEqual(["viewed"]);
    expect(unseenReceipt?.status).toBe("observed");
    expect(unseenReceipt?.eligibility).toBe("eligible");
    expect(unseenReceipt?.relevanceDecision).toBe("unknown");
    expect(unseenReceipt?.exposures).toEqual([]);
    expect(viewedReceipt?.sourceRefs).toEqual(["user:7"]);
    const stored = await fs.readFile(
      path.join(
        homeDirectory,
        "memory-receipts",
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
    const entry: MemoryEntryObservation = {
      entryId: randomUUID(),
      entryVersion: hash("banana"),
      receiptEpoch: "0",
      path: "personal/when/shopping/fruit.md",
      scope: "personal",
      topic: "shopping",
      summary: "banana",
    };
    const messages: ChatMessage[] = [
      { role: "system", content: "plain" },
      {
        role: "tool",
        name: "view_memory",
        content: "[cleared]",
        cleared: true,
        memoryDelivery: {
          path: entry.path,
          messageFingerprint: hash("banana"),
          deliveredVersion: hash("banana"),
          deliveredFingerprint: hash("banana"),
        },
      },
    ];
    const input = { runId: "run-8", iteration: 1, entries: [entry], messages, homeDirectory };
    const first = await beginMemoryOpportunities(input);
    const second = await beginMemoryOpportunities(input);
    expect(first[0]?.receipt.receiptId).toBe(second[0]?.receipt.receiptId);
    await completeMemoryOpportunities(first, messages);
    expect(
      await readMemoryOpportunityReceipts("personal", entry.entryId, 5, homeDirectory),
    ).toHaveLength(1);
    expect(
      (await readMemoryOpportunityReceipts("personal", entry.entryId, 5, homeDirectory))[0]
        ?.exposures,
    ).toEqual([]);
    await beginMemoryOpportunities(input);
    expect(
      (await readMemoryOpportunityReceipts("personal", entry.entryId, 5, homeDirectory))[0]?.status,
    ).toBe("observed");
    await eraseMemoryOpportunityReceiptsForScope("personal", homeDirectory);
    expect(
      await readMemoryOpportunityReceipts("personal", entry.entryId, 5, homeDirectory),
    ).toEqual([]);
  });

  test("marks conditional memory ineligible when view_memory was not offered", async () => {
    const entry: MemoryEntryObservation = {
      entryId: randomUUID(),
      entryVersion: hash("banana"),
      receiptEpoch: "0",
      path: "personal/when/food/fruit.md",
      scope: "personal",
      topic: "food",
      summary: "banana",
    };
    const tickets = await beginMemoryOpportunities({
      runId: "no-tool",
      iteration: 0,
      entries: [entry],
      messages: [{ role: "user", content: "shopping" }],
      homeDirectory,
      viewMemoryOffered: false,
    });
    expect(tickets[0]?.receipt.eligibility).toBe("ineligible");
    expect(tickets[0]?.receipt.eligibilityEvidence).toBe("view_memory_not_offered");
  });

  test("an in-flight request cannot restore a receipt after forgetting", async () => {
    const entry: MemoryEntryObservation = {
      entryId: randomUUID(),
      entryVersion: hash("banana"),
      receiptEpoch: "0",
      path: "personal/when/food/fruit.md",
      scope: "personal",
      topic: "food",
      summary: "banana",
    };
    const messages: ChatMessage[] = [{ role: "user", content: "shopping" }];
    const input = { runId: "in-flight", iteration: 0, entries: [entry], messages, homeDirectory };
    const tickets = await beginMemoryOpportunities(input);
    await eraseMemoryOpportunityReceiptsForScope("personal", homeDirectory);
    await completeMemoryOpportunities(tickets, messages);
    await beginMemoryOpportunities(input);
    expect(
      await readMemoryOpportunityReceipts("personal", entry.entryId, 5, homeDirectory),
    ).toEqual([]);
    expect(await readMemoryReceiptEpoch("personal", homeDirectory)).not.toBe("0");
  });
});
