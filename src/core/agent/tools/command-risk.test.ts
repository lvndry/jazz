import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { LLMService } from "@/core/interfaces/llm";
import { LLMServiceTag } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { Agent } from "@/core/types/agent";
import {
  classifyCommandRisk,
  parseClassifierVerdict,
  shouldClassifyExecuteCommand,
} from "./command-risk";

describe("shouldClassifyExecuteCommand", () => {
  it("runs only for execute_command under read-only or low-risk policy", () => {
    expect(shouldClassifyExecuteCommand("execute_command", "read-only", false)).toBe(true);
    expect(shouldClassifyExecuteCommand("execute_command", "low-risk", false)).toBe(true);
    expect(shouldClassifyExecuteCommand("execute_command", "high-risk", false)).toBe(false);
    expect(shouldClassifyExecuteCommand("execute_command", true, false)).toBe(false);
    expect(shouldClassifyExecuteCommand("execute_command", false, false)).toBe(false);
    expect(shouldClassifyExecuteCommand("execute_command", undefined, false)).toBe(false);
    expect(shouldClassifyExecuteCommand("write_file", "read-only", false)).toBe(false);
    expect(shouldClassifyExecuteCommand("execute_command", "read-only", true)).toBe(false);
  });
});

describe("parseClassifierVerdict", () => {
  it("accepts an exact read-only token", () => {
    expect(parseClassifierVerdict("read-only")).toBe("read-only");
    expect(parseClassifierVerdict("READ-ONLY")).toBe("read-only");
    expect(parseClassifierVerdict("  read-only  ")).toBe("read-only");
    expect(parseClassifierVerdict('"read-only"')).toBe("read-only");
    expect(parseClassifierVerdict("read-only.")).toBe("read-only");
  });

  it("fails closed on anything else", () => {
    expect(parseClassifierVerdict("high-risk")).toBe("high-risk");
    expect(parseClassifierVerdict("")).toBe("high-risk");
    expect(parseClassifierVerdict("read-only because it is git log")).toBe("high-risk");
    expect(parseClassifierVerdict("The command is read-only")).toBe("high-risk");
    expect(parseClassifierVerdict("read-only\nhigh-risk")).toBe("high-risk");
    expect(parseClassifierVerdict("readonly")).toBe("high-risk");
  });
});

describe("classifyCommandRisk", () => {
  const agent: Agent = {
    id: "agent-1",
    name: "test",
    model: "openai/gpt-4o-mini",
    config: { persona: "default", llmProvider: "openai", llmModel: "gpt-4o-mini" },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const silentLogger = {
    debug: () => Effect.void,
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    setSessionId: () => Effect.void,
    clearSessionId: () => Effect.void,
    writeToFile: () => Effect.void,
    logToolCall: () => Effect.void,
  } as unknown as LoggerService;

  function runWithLlm(
    createChatCompletion: LLMService["createChatCompletion"],
    command: string,
  ): Promise<string> {
    const llm = { createChatCompletion } as LLMService;
    return Effect.runPromise(
      classifyCommandRisk(command, agent).pipe(
        Effect.provideService(LLMServiceTag, llm),
        Effect.provideService(LoggerServiceTag, silentLogger),
      ),
    );
  }

  it("returns the model's read-only verdict", async () => {
    const risk = await runWithLlm(
      () => Effect.succeed({ id: "1", model: "gpt-4o-mini", content: "read-only" }),
      "git log -20",
    );
    expect(risk).toBe("read-only");
  });

  it("fails closed when the model errors", async () => {
    const risk = await runWithLlm(() => Effect.fail(new Error("provider down")), "git log -20");
    expect(risk).toBe("high-risk");
  });

  it("fails closed on an empty command or an oversized one", async () => {
    const unusedLlm = {
      createChatCompletion: () => {
        throw new Error("should not be called");
      },
    } as unknown as LLMService;

    const empty = await Effect.runPromise(
      classifyCommandRisk("", agent).pipe(
        Effect.provideService(LLMServiceTag, unusedLlm),
        Effect.provideService(LoggerServiceTag, silentLogger),
      ),
    );
    expect(empty).toBe("high-risk");

    const oversized = await Effect.runPromise(
      classifyCommandRisk("x".repeat(4_001), agent).pipe(
        Effect.provideService(LLMServiceTag, unusedLlm),
        Effect.provideService(LoggerServiceTag, silentLogger),
      ),
    );
    expect(oversized).toBe("high-risk");
  });
});
