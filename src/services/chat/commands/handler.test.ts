import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import type { Agent } from "@/core/types/agent";
import type { ChatMessage } from "@/core/types/message";
import { saveConversation } from "@/services/history/conversation-history-service";
import { handleSpecialCommand } from "./handler";
import type { CommandContext } from "./types";

let tmpDir = "";

mock.module("@/core/utils/runtime-detection", () => ({
  getHistoryDirectory: () => tmpDir,
  getUserDataDirectory: () => tmpDir,
  getGlobalUserDataDirectory: () => tmpDir,
  getPackageRootDirectory: () => null,
  getBuiltinSkillsDirectory: () => null,
  getGlobalSkillsDirectory: () => tmpDir,
  getAgentsSkillsDirectory: () => tmpDir,
  getBuiltinPersonasDirectory: () => null,
  getBuiltinWorkflowsDirectory: () => null,
  getGlobalWorkflowsDirectory: () => tmpDir,
  isRunningFromGlobalInstall: () => false,
  isRunningInDevelopmentMode: () => false,
  findExecutablePathViaShell: () => Effect.succeed(null),
  detectPackageManagerFromPath: () => null,
  getJazzSchedulerInvocation: () => Effect.succeed([]),
}));

const TEST_AGENT_ID = "test-agent-resume";

const testAgent: Agent = {
  id: TEST_AGENT_ID,
  name: "Test Agent",
  description: "Test agent for resume command tests",
  model: "openai/gpt-4",
  config: {
    persona: "default",
    llmProvider: "openai",
    llmModel: "gpt-4",
    tools: [],
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const testRecord = {
  conversationId: "conv-to-resume",
  title: "A past conversation",
  agentId: TEST_AGENT_ID,
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  endedAt: new Date(Date.now() - 3000_000).toISOString(),
  messageCount: 2,
  messages: [
    { role: "user" as const, content: "Hello" },
    { role: "assistant" as const, content: "Hi there" },
  ] as ChatMessage[],
};

function runEffect<A>(eff: Effect.Effect<A, unknown, NodeFileSystem.NodeFileSystem["Type"]>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-resume-handler-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleSpecialCommand resume", () => {
  test("sets resetStartedAt on the result when a conversation is successfully resumed", async () => {
    await runEffect(saveConversation(testRecord, tmpDir));

    const mockTerminal: Partial<TerminalService> = {
      select: mock(() => Effect.succeed("conv-to-resume")),
      success: mock(() => Effect.void),
      log: mock(() => Effect.succeed(undefined)),
      info: mock(() => Effect.void),
    };

    const terminalLayer = Layer.succeed(
      TerminalServiceTag,
      mockTerminal as unknown as TerminalService,
    );
    const testLayer = Layer.merge(terminalLayer, NodeFileSystem.layer);

    const context: CommandContext = {
      agent: testAgent,
      conversationId: "current-conv-id",
      conversationHistory: [],
      sessionId: "test-session",
      sessionUsage: { promptTokens: 0, completionTokens: 0 },
      sessionStartedAt: new Date(Date.now() - 1800_000),
    };

    const result = await Effect.runPromise(
      handleSpecialCommand({ type: "resume", args: [] }, context).pipe(
        Effect.provide(testLayer),
      ),
    );

    expect(result.resetStartedAt).toBe(true);
  });
});
