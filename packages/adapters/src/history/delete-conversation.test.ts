import { existsSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { testProposedGoal } from "@jazz/core/agent/goal/test-fixtures";
import { browserScreenshotDirectory } from "@jazz/core/agent/tools/browser/browser-tools";
import { computerCapturesDirectory } from "@jazz/core/agent/tools/computer/grants";
import { getTodoFilePath } from "@jazz/core/agent/tools/todo";
import { conversationLogGroup } from "@jazz/core/utils/log-group";
import { getWorkStateDirectory } from "@jazz/core/utils/paths";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, FileSystem } from "effect";
import { JobQueueServiceImpl } from "../job-queue-service";
import { getLogsDirectory } from "../logger";
import { FileGoalStore } from "../storage/goal-store";
import { saveConversation } from "./conversation-history-service";
import { holdConversationTurn } from "./conversation-lease";
import {
  archivedConversationLogPath,
  conversationLogPath,
  EMPTY_CONVERSATION_REVISION,
} from "./conversation-log";
import { ConversationInUseError, deleteConversation } from "./delete-conversation";

const AGENT_ID = "delete-agent";

let conversationCounter = 0;
function nextConversationId(): string {
  conversationCounter += 1;
  return `delete-conversation-${String(conversationCounter)}`;
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

async function saveTranscript(conversationId: string): Promise<void> {
  await run(
    saveConversation({
      agentId: AGENT_ID,
      conversationId,
      title: "",
      startedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "hello" }],
      basedOn: EMPTY_CONVERSATION_REVISION,
    }),
  );
}

async function writeFile(filePath: string): Promise<void> {
  await nodeFs.mkdir(path.dirname(filePath), { recursive: true });
  await nodeFs.writeFile(filePath, "kept");
}

const createdTodoFiles: string[] = [];
afterEach(async () => {
  await Promise.all(createdTodoFiles.map((filePath) => nodeFs.rm(filePath, { force: true })));
  createdTodoFiles.length = 0;
});

describe("deleteConversation", () => {
  it("removes the conversation and everything kept for it, and nothing of another's", async () => {
    const conversationId = nextConversationId();
    const otherConversationId = nextConversationId();
    await saveTranscript(conversationId);
    await saveTranscript(otherConversationId);

    const logsDirectory = getLogsDirectory();
    const group = conversationLogGroup(AGENT_ID, conversationId);
    const keptFiles = [
      archivedConversationLogPath(AGENT_ID, conversationId),
      path.join(getWorkStateDirectory(AGENT_ID, conversationId), "state.json"),
      path.join(logsDirectory, `${group}.log`),
      path.join(logsDirectory, `${group}.log.1`),
      path.join(logsDirectory, `${conversationId}.log`),
      getTodoFilePath(conversationId),
      path.join(browserScreenshotDirectory(conversationId), "shot.png"),
      path.join(computerCapturesDirectory(conversationId), "capture.png"),
    ];
    const othersFiles = [
      path.join(logsDirectory, `${otherConversationId}.log`),
      path.join(logsDirectory, `${conversationId}0.log`),
      getTodoFilePath(otherConversationId),
    ];
    createdTodoFiles.push(getTodoFilePath(conversationId), getTodoFilePath(otherConversationId));
    for (const filePath of [...keptFiles, ...othersFiles]) {
      await writeFile(filePath);
    }

    await run(deleteConversation(AGENT_ID, conversationId));

    expect(existsSync(conversationLogPath(AGENT_ID, conversationId))).toBe(false);
    for (const filePath of keptFiles) {
      expect(existsSync(filePath)).toBe(false);
    }
    expect(existsSync(conversationLogPath(AGENT_ID, otherConversationId))).toBe(true);
    for (const filePath of othersFiles) {
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it("refuses while a goal still works in it, and deletes once the goal is finished", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(conversationId);
    const goals = new FileGoalStore();
    const goal = await Effect.runPromise(
      goals.create(
        testProposedGoal({ goalId: `goal-${conversationId}`, agentId: AGENT_ID, conversationId }),
      ),
    );

    const refused = await run(deleteConversation(AGENT_ID, conversationId).pipe(Effect.flip));
    expect(refused).toBeInstanceOf(ConversationInUseError);
    expect(refused.message).toContain("goal");
    expect(existsSync(conversationLogPath(AGENT_ID, conversationId))).toBe(true);

    await Effect.runPromise(
      goals.compareAndSet(goal.goalId, goal.version, { ...goal, state: { kind: "canceled" } }),
    );
    await run(deleteConversation(AGENT_ID, conversationId));
    expect(existsSync(conversationLogPath(AGENT_ID, conversationId))).toBe(false);
  });

  it("refuses while a turn holds the conversation", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(conversationId);

    const refused = await run(
      Effect.scoped(
        Effect.andThen(
          holdConversationTurn(AGENT_ID, conversationId),
          deleteConversation(AGENT_ID, conversationId).pipe(Effect.flip),
        ),
      ),
    );
    expect(refused).toBeInstanceOf(ConversationInUseError);
    expect(refused.message).toContain("turn");
  });

  it("deletes a conversation whose job batch was already delivered but not yet archived", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(conversationId);
    const batchFile = await writeDeliveredBatch(conversationId);

    await run(deleteConversation(AGENT_ID, conversationId));
    expect(existsSync(conversationLogPath(AGENT_ID, conversationId))).toBe(false);
    await nodeFs.rm(batchFile, { force: true });
  });

  it("refuses to delete while a job batch's report is still undelivered", async () => {
    const conversationId = nextConversationId();
    await saveTranscript(conversationId);
    const batchFile = await writeFinishedBatch(conversationId);

    const refused = await run(deleteConversation(AGENT_ID, conversationId).pipe(Effect.flip));
    expect(refused).toBeInstanceOf(ConversationInUseError);
    expect(refused.message).toContain("Background work");
    expect(existsSync(conversationLogPath(AGENT_ID, conversationId))).toBe(true);
    await nodeFs.rm(batchFile, { force: true });
  });
});

/**
 * A batch whose jobs are all terminal, with or without the fan-in report already delivered.
 * Returns the batch file path so the test can clean it up.
 */
async function writeBatch(
  conversationId: string,
  batchId: string,
  stage: "finished" | "delivered",
): Promise<string> {
  const now = Date.now();
  const batchFile = path.join(
    new JobQueueServiceImpl().baseJobBatchDirectory,
    AGENT_ID,
    `${batchId}.json`,
  );
  await nodeFs.mkdir(path.dirname(batchFile), { recursive: true });
  await nodeFs.writeFile(
    batchFile,
    JSON.stringify({
      schemaVersion: 2,
      id: batchId,
      agentId: AGENT_ID,
      conversationId,
      workingDir: "/tmp",
      concurrencyCap: 1,
      backoff: { initialMs: 2000, maxMs: 300_000 },
      reason: "Wait for the deploy to finish",
      createdAt: now,
      completedAt: now,
      deliveredAt: stage === "delivered" ? now : null,
      jobs: [
        {
          id: "job-1",
          command: "true",
          status: "succeeded",
          attempt: 1,
          maxAttempts: 1,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          result: { stdout: "", stderr: "", exitCode: 0 },
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  return batchFile;
}

function writeDeliveredBatch(conversationId: string) {
  return writeBatch(conversationId, `delivered-${conversationId}`, "delivered");
}

function writeFinishedBatch(conversationId: string) {
  return writeBatch(conversationId, `finished-${conversationId}`, "finished");
}
