import { existsSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { testProposedGoal } from "@jazz/core/agent/goal/test-fixtures";
import { createRunRecord } from "@jazz/core/agent/run/run-record";
import type { RunState } from "@jazz/core/agent/run/run-state";
import { getWorkStateDirectory } from "@jazz/core/utils/paths";
import { describe, expect, it } from "bun:test";
import { Effect, FileSystem } from "effect";
import { loadConversation, loadHistory, saveConversation } from "./conversation-history-service";
import { holdConversationTurn } from "./conversation-lease";
import {
  archivedConversationLogPath,
  conversationLogPath,
  conversationRevision,
  EMPTY_CONVERSATION_REVISION,
} from "./conversation-log";
import { ConversationInUseError } from "./delete-conversation";
import { archivedWorkStateDirectory, moveConversationToAgent } from "./move-conversation";
import { JobQueueServiceImpl } from "../job-queue-service";
import { FileGoalStore } from "../storage/goal-store";
import { FileRunStore } from "../storage/run-store";

const FROM_AGENT_ID = "move-from-agent";
const TO_AGENT_ID = "move-to-agent";

let conversationCounter = 0;
function nextConversationId(): string {
  conversationCounter += 1;
  return `move-conversation-${String(conversationCounter)}`;
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

const firstMessages = [
  { role: "user" as const, content: "help me plan a body recomposition" },
  { role: "assistant" as const, content: "Start with your current numbers." },
];

async function saveTranscript(agentId: string, conversationId: string): Promise<void> {
  await run(
    saveConversation({
      agentId,
      conversationId,
      title: "Body recomposition",
      startedAt: new Date().toISOString(),
      messages: firstMessages,
      basedOn: EMPTY_CONVERSATION_REVISION,
    }),
  );
}

async function writeWorkFile(agentId: string, conversationId: string, name: string): Promise<void> {
  const workFile = path.join(getWorkStateDirectory(agentId, conversationId), name);
  await nodeFs.mkdir(path.dirname(workFile), { recursive: true });
  await nodeFs.writeFile(workFile, "kept");
}

let runCounter = 0;
async function parkRun(conversationId: string, expiresAt: Date): Promise<string> {
  runCounter += 1;
  const runId = `aaaaaaaa-0000-0000-0000-${String(runCounter).padStart(12, "0")}`;
  const parked: RunState = {
    kind: "input-required",
    pending: {
      kind: "tool-approval",
      request: {
        toolCallId: "call_1",
        toolName: "execute_command",
        message: "Kill the leftover process",
        executeToolName: "execute_command_execute",
        executeArgs: { command: "kill 4242" },
      },
    },
    snapshot: { messages: [], iteration: 1 },
    expiresAt: expiresAt.toISOString(),
  };
  const created = createRunRecord({
    runId,
    agentId: FROM_AGENT_ID,
    conversationId,
    input: "Background job batch finished",
    now: new Date(),
  });
  await Effect.runPromise(new FileRunStore().save({ ...created, state: parked }));
  return runId;
}

const DAY_MS = 24 * 60 * 60_000;

type BatchStage = "running" | "finished";

async function writeBatch(
  conversationId: string,
  batchId: string,
  stage: BatchStage,
): Promise<string> {
  const now = Date.now();
  const batchFile = path.join(
    new JobQueueServiceImpl().baseJobBatchDirectory,
    FROM_AGENT_ID,
    `${batchId}.json`,
  );
  await nodeFs.mkdir(path.dirname(batchFile), { recursive: true });
  await nodeFs.writeFile(
    batchFile,
    JSON.stringify({
      schemaVersion: 2,
      id: batchId,
      agentId: FROM_AGENT_ID,
      conversationId,
      workingDir: "/tmp",
      concurrencyCap: 1,
      backoff: { initialMs: 2000, maxMs: 300_000 },
      reason: "Wait for the deploy to finish",
      createdAt: now,
      completedAt: stage === "finished" ? now : null,
      deliveredAt: null,
      jobs: [
        {
          id: "job-1",
          command: "true",
          status: stage === "finished" ? "succeeded" : "running",
          attempt: 1,
          maxAttempts: 1,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          result: stage === "finished" ? { stdout: "", stderr: "", exitCode: 0 } : null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  return batchFile;
}

describe("moveConversationToAgent", () => {
  it("leaves one conversation, under the new agent, that later saves keep appending to", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    const workFile = path.join(getWorkStateDirectory(FROM_AGENT_ID, conversationId), "state.json");
    await nodeFs.mkdir(path.dirname(workFile), { recursive: true });
    await nodeFs.writeFile(workFile, "kept");

    expect(await run(moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId))).toBe(
      true,
    );

    expect(existsSync(conversationLogPath(FROM_AGENT_ID, conversationId))).toBe(false);
    const fromHistory = await run(loadHistory(FROM_AGENT_ID));
    expect(fromHistory.conversations.map((summary) => summary.conversationId)).not.toContain(
      conversationId,
    );
    const moved = await run(loadConversation(TO_AGENT_ID, conversationId));
    expect(moved?.agentId).toBe(TO_AGENT_ID);
    expect(moved?.title).toBe("Body recomposition");
    expect(moved?.messages.map((message) => message.content)).toEqual(
      firstMessages.map((message) => message.content),
    );
    expect(
      existsSync(path.join(getWorkStateDirectory(TO_AGENT_ID, conversationId), "state.json")),
    ).toBe(true);
    expect(existsSync(workFile)).toBe(false);

    const continued = [...firstMessages, { role: "user" as const, content: "and my macros?" }];
    await run(
      saveConversation({
        agentId: TO_AGENT_ID,
        conversationId,
        title: "Body recomposition",
        startedAt: new Date().toISOString(),
        messages: continued,
        basedOn: conversationRevision(firstMessages),
      }),
    );
    const after = await run(loadConversation(TO_AGENT_ID, conversationId));
    expect(after?.messages).toHaveLength(continued.length);
  });

  it("archives a copy the new agent already held under the same id", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    await saveTranscript(TO_AGENT_ID, conversationId);

    await run(moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId));

    expect(existsSync(archivedConversationLogPath(TO_AGENT_ID, conversationId))).toBe(true);
    expect(existsSync(conversationLogPath(TO_AGENT_ID, conversationId))).toBe(true);
    expect(existsSync(conversationLogPath(FROM_AGENT_ID, conversationId))).toBe(false);
  });

  it("keeps the new agent's own work state with its archived copy instead of deleting it", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    await saveTranscript(TO_AGENT_ID, conversationId);
    await writeWorkFile(FROM_AGENT_ID, conversationId, "moving.json");
    await writeWorkFile(TO_AGENT_ID, conversationId, "replaced.json");

    await run(moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId));

    expect(
      existsSync(
        path.join(archivedWorkStateDirectory(TO_AGENT_ID, conversationId), "replaced.json"),
      ),
    ).toBe(true);
    const destinationWork = getWorkStateDirectory(TO_AGENT_ID, conversationId);
    expect(existsSync(path.join(destinationWork, "moving.json"))).toBe(true);
    expect(existsSync(path.join(destinationWork, "replaced.json"))).toBe(false);
  });

  it("leaves the conversation whole under its current agent when the log cannot move", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    await writeWorkFile(FROM_AGENT_ID, conversationId, "state.json");
    // A directory where the moved log would be written makes that write fail.
    await nodeFs.mkdir(conversationLogPath(TO_AGENT_ID, conversationId), { recursive: true });

    await run(
      moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId).pipe(Effect.flip),
    );

    const stayed = await run(loadConversation(FROM_AGENT_ID, conversationId));
    expect(stayed?.messages).toHaveLength(firstMessages.length);
    expect(
      existsSync(path.join(getWorkStateDirectory(FROM_AGENT_ID, conversationId), "state.json")),
    ).toBe(true);
    expect(existsSync(getWorkStateDirectory(TO_AGENT_ID, conversationId))).toBe(false);
  });

  it("succeeds without moving anything when nothing was saved yet", async () => {
    const conversationId = nextConversationId();
    expect(await run(moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId))).toBe(
      false,
    );
    expect(existsSync(conversationLogPath(TO_AGENT_ID, conversationId))).toBe(false);
  });

  it("refuses while a goal still works in it under the current agent", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    await Effect.runPromise(
      new FileGoalStore().create(
        testProposedGoal({
          goalId: `goal-${conversationId}`,
          agentId: FROM_AGENT_ID,
          conversationId,
        }),
      ),
    );

    const refused = await run(
      moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId).pipe(Effect.flip),
    );
    expect(refused).toBeInstanceOf(ConversationInUseError);
    expect(existsSync(conversationLogPath(FROM_AGENT_ID, conversationId))).toBe(true);
    expect(existsSync(conversationLogPath(TO_AGENT_ID, conversationId))).toBe(false);
  });

  it("refuses while a turn is running in it", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);

    const refused = await run(
      Effect.scoped(
        Effect.andThen(
          holdConversationTurn(FROM_AGENT_ID, conversationId),
          moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId).pipe(Effect.flip),
        ),
      ),
    );
    expect(refused).toBeInstanceOf(ConversationInUseError);
    expect(existsSync(conversationLogPath(FROM_AGENT_ID, conversationId))).toBe(true);
  });
  it("refuses while a run waits for an answer, naming the commands that clear it", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    const runId = await parkRun(conversationId, new Date(Date.now() + DAY_MS));

    const refused = await run(
      moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId).pipe(Effect.flip),
    );
    expect(refused).toBeInstanceOf(ConversationInUseError);
    expect(refused.message).toContain(`jazz runs cancel ${runId}`);
  });

  it("moves past a parked run whose deadline already passed", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    await parkRun(conversationId, new Date(Date.now() - DAY_MS));

    expect(await run(moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId))).toBe(
      true,
    );
  });

  it("carries a finished, unreported job batch to the new agent", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    const batchId = `carry${String(conversationCounter)}`;
    const sourceFile = await writeBatch(conversationId, batchId, "finished");

    expect(await run(moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId))).toBe(
      true,
    );
    expect(existsSync(sourceFile)).toBe(false);
    const carried = await Effect.runPromise(
      Effect.provide(
        new JobQueueServiceImpl().listActiveBatches(TO_AGENT_ID),
        NodeFileSystem.layer,
      ),
    );
    expect(carried.find((batch) => batch.id === batchId)?.agentId).toBe(TO_AGENT_ID);
  });

  it("refuses while a job batch is still running", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    const sourceFile = await writeBatch(
      conversationId,
      `running${String(conversationCounter)}`,
      "running",
    );

    const refused = await run(
      moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId).pipe(Effect.flip),
    );
    expect(refused).toBeInstanceOf(ConversationInUseError);
    expect(existsSync(sourceFile)).toBe(true);
    await nodeFs.rm(sourceFile, { force: true });
  });

  it("puts a carried job batch back when the log cannot move", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(FROM_AGENT_ID, conversationId);
    const sourceFile = await writeBatch(
      conversationId,
      `back${String(conversationCounter)}`,
      "finished",
    );
    await nodeFs.mkdir(conversationLogPath(TO_AGENT_ID, conversationId), { recursive: true });

    await run(
      moveConversationToAgent(FROM_AGENT_ID, TO_AGENT_ID, conversationId).pipe(Effect.flip),
    );
    expect(existsSync(sourceFile)).toBe(true);
  });
});
