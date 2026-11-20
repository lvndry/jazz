import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { silentLogger } from "@/core/agent/test-logger";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { partialFake } from "@/core/test-support/fakes";
import type { Agent } from "@/core/types/agent";
import type { ChatCompletionOptions } from "@/core/types/chat";
import type { ChatMessage } from "@/core/types/message";
import {
  formatExchangeForNamer,
  nameConversation,
  titleFromNamerReply,
} from "./conversation-title";
import { cleanConversationTitle, MAX_CONVERSATION_TITLE_CHARS } from "./conversation-title-text";

const agent: Agent = {
  id: "agent-1",
  name: "test",
  config: {
    persona: "default",
    llm: { provider: "openai", model: "gpt-4o", summarizerModel: "openai/gpt-4o-mini" },
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const answered: ChatMessage[] = [
  { role: "system", content: "You are Jazz." },
  { role: "user", content: "can you help me plan a train trip through italy" },
  { role: "assistant", content: "", tool_calls: [] },
  { role: "assistant", content: "Sure. Start in Milan, then Florence." },
];

function runNamer(
  messages: readonly ChatMessage[],
  reply: string,
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
) {
  const requests: ChatCompletionOptions[] = [];
  const llm = partialFake<LLMService>({
    createChatCompletion: (_provider: string, options: ChatCompletionOptions) => {
      requests.push(options);
      return Effect.succeed({
        id: "1",
        model: options.model,
        content: reply,
        ...(usage !== undefined ? { usage } : {}),
      });
    },
  });
  const exit = Effect.runPromiseExit(
    nameConversation(agent, messages).pipe(
      Effect.provideService(LLMServiceTag, llm),
      Effect.provideService(LoggerServiceTag, silentLogger),
    ),
  );
  return { exit, requests };
}

describe("formatExchangeForNamer", () => {
  it("pairs the first user message with the agent's written answer", () => {
    const exchange = formatExchangeForNamer(answered);
    expect(exchange).toContain("can you help me plan a train trip through italy");
    expect(exchange).toContain("Sure. Start in Milan, then Florence.");
    expect(exchange).not.toContain("You are Jazz.");
  });

  it("has nothing to name before the first message is answered", () => {
    expect(formatExchangeForNamer([{ role: "user", content: "hello" }])).toBeUndefined();
    expect(formatExchangeForNamer([])).toBeUndefined();
  });

  it("reads the first turn's last written reply, not a later turn's", () => {
    const exchange = formatExchangeForNamer([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Let me check." },
      { role: "assistant", content: "answer to the first" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "answer to the second" },
    ]);
    expect(exchange).toContain("answer to the first");
    expect(exchange).not.toContain("Let me check.");
    expect(exchange).not.toContain("answer to the second");
  });

  it("passes over a prompt its turn never answered, keeping each pair matched", () => {
    const exchange = formatExchangeForNamer([
      { role: "user", content: "plan a trip to Italy" },
      { role: "assistant", content: "", tool_calls: [] },
      { role: "user", content: "what's a good sourdough hydration?" },
      { role: "assistant", content: "Around 75% is a forgiving start." },
    ]);
    expect(exchange).toContain("what's a good sourdough hydration?");
    expect(exchange).toContain("Around 75% is a forgiving start.");
    expect(exchange).not.toContain("plan a trip to Italy");
  });
});

describe("titleFromNamerReply", () => {
  it("skips a preamble line that introduces the title", () => {
    expect(titleFromNamerReply("Here is a title:\nSourdough hydration basics")).toBe(
      "Sourdough hydration basics",
    );
  });

  it("has no title when the reply is a sentence rather than a few words", () => {
    expect(
      titleFromNamerReply(
        "Sure, I can help you think about what this conversation is about and name it well",
      ),
    ).toBeUndefined();
  });

  it("has no title when every line is a preamble", () => {
    expect(titleFromNamerReply("Here are a few suggestions:")).toBeUndefined();
  });
});

describe("cleanConversationTitle", () => {
  it("drops quotes, a label, and a trailing period", () => {
    expect(cleanConversationTitle('Title: "Italy rail itinerary."')).toBe("Italy rail itinerary");
  });

  it("removes bidirectional formatting controls", () => {
    expect(cleanConversationTitle("Invoice\u202Efdp.exe")).toBe("Invoicefdp.exe");
  });

  it("caps a long title", () => {
    const title = cleanConversationTitle("word ".repeat(40));
    expect(title?.endsWith("…")).toBe(true);
    expect(Array.from(title ?? "").length).toBe(MAX_CONVERSATION_TITLE_CHARS);
  });
});

describe("nameConversation", () => {
  it("asks the harness model and cleans its reply", async () => {
    const { exit, requests } = runNamer(answered, '"Italy rail itinerary"\n');
    const result = await exit;
    expect(Exit.isSuccess(result) ? result.value.title : undefined).toBe("Italy rail itinerary");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("gpt-4o-mini");
    expect(requests[0]?.tools).toBeUndefined();
  });

  it("reports the call's tokens so its spend can be recorded", async () => {
    const { exit } = runNamer(answered, "Italy rail itinerary", {
      promptTokens: 120,
      completionTokens: 6,
      totalTokens: 126,
    });
    const result = await exit;
    expect(Exit.isSuccess(result) ? result.value.spend.totalTokens : undefined).toBe(126);
  });

  it("makes no call before the first message is answered", async () => {
    const { exit, requests } = runNamer([{ role: "user", content: "hello" }], "Greeting");
    expect(Exit.isFailure(await exit)).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("has no title for an empty reply, so the conversation keeps its own", async () => {
    const { exit } = runNamer(answered, "  \n");
    const result = await exit;
    expect(Exit.isSuccess(result) ? result.value.title : "unexpected").toBeUndefined();
  });
});
