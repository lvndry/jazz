import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { LLMService } from "@/core/interfaces/llm";
import { LLMServiceTag } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { Agent } from "@/core/types/agent";
import {
  classifyCommandRisk,
  formatConversationForClassifier,
  parseClassifierVerdict,
  shouldClassifyExecuteCommand,
} from "./command-risk";

describe("shouldClassifyExecuteCommand", () => {
  it("runs only for unknown risk in safe mode", () => {
    expect(shouldClassifyExecuteCommand("unknown", false, false)).toBe(true);
    expect(shouldClassifyExecuteCommand("unknown", undefined, false)).toBe(true);
    expect(shouldClassifyExecuteCommand("unknown", "read-only", false)).toBe(false);
    expect(shouldClassifyExecuteCommand("unknown", "low-risk", false)).toBe(false);
    expect(shouldClassifyExecuteCommand("unknown", "high-risk", false)).toBe(false);
    expect(shouldClassifyExecuteCommand("unknown", true, false)).toBe(false);
    expect(shouldClassifyExecuteCommand("high-risk", false, false)).toBe(false);
    expect(shouldClassifyExecuteCommand("unknown", false, true)).toBe(false);
  });
});

describe("parseClassifierVerdict", () => {
  it("accepts an exact read-only or low-risk token", () => {
    expect(parseClassifierVerdict("read-only")).toBe("read-only");
    expect(parseClassifierVerdict("READ-ONLY")).toBe("read-only");
    expect(parseClassifierVerdict("  read-only  ")).toBe("read-only");
    expect(parseClassifierVerdict('"read-only"')).toBe("read-only");
    expect(parseClassifierVerdict("read-only.")).toBe("read-only");
    expect(parseClassifierVerdict("low-risk")).toBe("low-risk");
    expect(parseClassifierVerdict("LOW-RISK")).toBe("low-risk");
    expect(parseClassifierVerdict('"low-risk"')).toBe("low-risk");
  });

  it("fails closed on anything else", () => {
    expect(parseClassifierVerdict("high-risk")).toBe("high-risk");
    expect(parseClassifierVerdict("")).toBe("high-risk");
    expect(parseClassifierVerdict("read-only because it is git log")).toBe("high-risk");
    expect(parseClassifierVerdict("The command is read-only")).toBe("high-risk");
    expect(parseClassifierVerdict("read-only\nhigh-risk")).toBe("high-risk");
    expect(parseClassifierVerdict("readonly")).toBe("high-risk");
    expect(parseClassifierVerdict("lowrisk")).toBe("high-risk");
  });
});

describe("formatConversationForClassifier", () => {
  it("keeps the last five user requests and a snippet of each answer", () => {
    const history = ["one", "two", "three", "four", "five", "six"].flatMap((label) => [
      { role: "user" as const, content: label },
      { role: "assistant" as const, content: `ok ${label}` },
    ]);
    const formatted = formatConversationForClassifier([
      { role: "system", content: "you are jazz" },
      ...history,
      { role: "tool", content: "huge tool dump" },
      { role: "assistant", content: "compaction", kind: "summary" },
    ]);
    expect(formatted).toBe(
      [
        "user: two",
        "assistant: ok two",
        "user: three",
        "assistant: ok three",
        "user: four",
        "assistant: ok four",
        "user: five",
        "assistant: ok five",
        "user: six",
        "assistant: ok six",
      ].join("\n"),
    );
    expect(formatted).not.toContain("user: one");
  });

  it("pairs a user turn with the next assistant reply and ignores tool dumps", () => {
    const formatted = formatConversationForClassifier([
      { role: "user", content: "show git status" },
      { role: "tool", content: "huge tool dump" },
      { role: "assistant", content: "I will check status" },
      { role: "user", content: "and the diff" },
    ]);
    expect(formatted).toBe(
      "user: show git status\nassistant: I will check status\nuser: and the diff",
    );
  });

  it("snippets a long assistant reply and hard-caps the conversation at 800 characters", () => {
    const formatted = formatConversationForClassifier([
      { role: "user", content: "look around" },
      { role: "assistant", content: `${"a".repeat(200)}\n\nmore detail` },
    ]);
    expect(formatted).toBe(`user: look around\nassistant: ${"a".repeat(80)}…`);

    const longUser = formatConversationForClassifier([{ role: "user", content: "x".repeat(900) }]);
    expect(longUser).toHaveLength(800);
    expect(longUser?.endsWith("…")).toBe(true);
    expect(formatConversationForClassifier([{ role: "tool", content: "ignored" }])).toBeUndefined();
  });

  it("drops older user turns when they would exceed the 800 character budget", () => {
    const turns = [1, 2, 3, 4, 5].map((index) => ({
      role: "user" as const,
      content: `request ${index} ${"w".repeat(180)}`,
    }));
    const formatted = formatConversationForClassifier(turns);
    expect(formatted).toBeDefined();
    expect(formatted!.length).toBeLessThanOrEqual(800);
    expect(formatted).toContain("request 5");
    expect(formatted).not.toContain("request 1");
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

  it("includes conversation context in the classifier request", async () => {
    let capturedUserContent = "";
    const risk = await Effect.runPromise(
      classifyCommandRisk("git status", agent, [
        { role: "user", content: "just look at the repo state" },
      ]).pipe(
        Effect.provideService(LLMServiceTag, {
          createChatCompletion: (_provider, options) => {
            const userMessage = options.messages.find((message) => message.role === "user");
            capturedUserContent = userMessage?.content ?? "";
            return Effect.succeed({ id: "1", model: "gpt-4o-mini", content: "read-only" });
          },
        } as LLMService),
        Effect.provideService(LoggerServiceTag, silentLogger),
      ),
    );
    expect(risk).toBe("read-only");
    expect(capturedUserContent).toContain("<command>\ngit status\n</command>");
    expect(capturedUserContent).toContain(
      "<conversation>\nuser: just look at the repo state\n</conversation>",
    );
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
