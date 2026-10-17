/**
 * Exercises `/learn` against real saved history and memory storage. A failure before model
 * execution must return its reflection claim, so repairing storage lets the same messages retry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import {
  EMPTY_CONVERSATION_REVISION,
  loadConversationOrNull,
  saveConversation,
} from "@jazz/adapters/history/conversation-history-service";
import { MemoryServiceImpl } from "@jazz/adapters/memory-service";
import { claimUnreflectedMessages } from "@jazz/adapters/reflection-watermark";
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, type FileSystem } from "effect";
import { handleLearnCommand } from "./learn";
import type { CommandContext, CommandResult } from "./types";

let tmpDir: string;
let previousJazzHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-learn-command-test-"));
  previousJazzHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = tmpDir;
});

afterEach(() => {
  if (previousJazzHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousJazzHome;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

const agent: Agent = {
  id: "learn-test-agent",
  name: "Learn test agent",
  description: "Exercises reflection claim cleanup before inference.",
  config: { persona: "default", llm: { provider: "openai", model: "gpt-4" }, tools: [] },
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function fixture() {
  const conversationId = `learn-${path.basename(tmpDir)}`;
  const revision = await runEffect(
    saveConversation(
      {
        agentId: agent.id,
        conversationId,
        title: "Learning from this conversation",
        startedAt: new Date().toISOString(),
        messages: [
          { role: "user", content: "I always prefer tea." },
          { role: "assistant", content: "Understood." },
        ],
        basedOn: EMPTY_CONVERSATION_REVISION,
      },
      undefined,
      { housekeeping: false },
    ),
  );
  const saved = await runEffect(loadConversationOrNull(agent.id, conversationId));
  if (saved === null) throw new Error("The test conversation was not saved.");
  const memoryDirectory = path.join(tmpDir, "memory");
  const service = new MemoryServiceImpl({
    baseMemoryDirectory: memoryDirectory,
    receiptsDirectory: path.join(tmpDir, "receipts"),
  });
  const context: CommandContext = {
    agent,
    conversationId,
    conversationRevision: revision,
    conversationHistory: saved.messages,
    memoryAtSessionStart: new Map(),
    sessionUsage: { requests: 0, promptTokens: 0, completionTokens: 0 },
    sessionTurnCount: 0,
    sessionLimits: {},
    sessionStartedAt: new Date(),
  };
  return { context, memoryDirectory, saved, service };
}

function runLearn(context: CommandContext, service: MemoryServiceImpl) {
  const terminal: Partial<TerminalService> = { log: () => Effect.succeed(undefined) };
  return handleLearnCommand(context).pipe(
    Effect.provideService(MemoryServiceTag, service),
    Effect.provideService(TerminalServiceTag, terminal as TerminalService),
    Effect.provide(NodeFileSystem.layer),
  ) as Effect.Effect<CommandResult, unknown>;
}

test("a pending-queue read failure releases the claimed conversation for retry", async () => {
  const { context, memoryDirectory, saved, service } = await fixture();
  const queuePath = path.join(memoryDirectory, ".pending-memory.json");
  fs.mkdirSync(queuePath, { recursive: true });
  const outcome = await Effect.runPromiseExit(runLearn(context, service));
  expect(outcome._tag).toBe("Failure");
  expect(String(outcome)).toContain("EISDIR");

  fs.rmSync(queuePath, { recursive: true });
  const retry = await runEffect(
    claimUnreflectedMessages(memoryDirectory, agent.id, context.conversationId, saved.messages),
  );
  expect(retry.messages.map((message) => message.entryId)).toEqual(
    saved.messages.map((message) => message.entryId),
  );
});

test("interruption while loading suggestions releases the claimed conversation", async () => {
  const { context, memoryDirectory, saved } = await fixture();
  const readingSuggestions = Deferred.makeUnsafe<void>();
  class InterruptedMemoryService extends MemoryServiceImpl {
    override readonly pendingSuggestions = () =>
      Deferred.succeed(readingSuggestions, undefined).pipe(Effect.andThen(Effect.never));
  }
  const service = new InterruptedMemoryService({
    baseMemoryDirectory: memoryDirectory,
    receiptsDirectory: path.join(tmpDir, "receipts"),
  });
  const fiber = Effect.runFork(runLearn(context, service));
  await Effect.runPromise(Deferred.await(readingSuggestions));
  await Effect.runPromise(Fiber.interrupt(fiber));
  const retry = await runEffect(
    claimUnreflectedMessages(memoryDirectory, agent.id, context.conversationId, saved.messages),
  );
  expect(retry.messages.map((message) => message.entryId)).toEqual(
    saved.messages.map((message) => message.entryId),
  );
});
