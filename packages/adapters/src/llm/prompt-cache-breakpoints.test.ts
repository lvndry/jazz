/**
 * Request-assembly tests for prompt-cache breakpoints. The Anthropic cases drive the real
 * `@ai-sdk/anthropic` serializer against a stub transport and read the wire body, because the
 * breakpoint rules (which tools and system blocks carry one, the limit of 4) live in that
 * package rather than in Jazz. The same transport verifies tuple schema dialect conversion
 * for memory and scratchpad tools before Anthropic receives the request.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createViewMemoryTool } from "@jazz/core/agent/tools/memory";
import { createViewWorkspaceTool } from "@jazz/core/agent/tools/workspace";
import type { ProviderName } from "@jazz/core/constants/models";
import { generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { fakeFetch, partialFake } from "../test-support/fakes";
import { applyToolsCacheBreakpoint, buildToolInputSchema, toCoreMessages } from "./ai-sdk-service";
import fixture from "./fixtures/system-prompt-requests.json";

const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;

const STABLE_TEXT = "Persona and rules.";
const LIVE_TEXT = "\n\nEnvironment: Date: 2026-03-01";

interface WireBody {
  tools?: Array<{ name: string; input_schema?: unknown; cache_control?: unknown }>;
  system?: Array<{ text: string; cache_control?: unknown }>;
  messages: Array<{ role: string; content: Array<{ text?: string; cache_control?: unknown }> }>;
}

function buildTools(): ToolSet {
  const emptyObject = jsonSchema({ type: "object", properties: {} });
  return {
    read_file: tool({ description: "Read a file", inputSchema: emptyObject }),
    grep: tool({ description: "Search files", inputSchema: emptyObject }),
    mv: tool({ description: "Move a file", inputSchema: emptyObject }),
  };
}

function systemMessage(live: string) {
  return {
    role: "system" as const,
    content: `${STABLE_TEXT}${live}`,
    stablePrefixLength: STABLE_TEXT.length,
  };
}

async function sendToAnthropic(coreMessages: ModelMessage[], tools: ToolSet): Promise<WireBody> {
  let captured: WireBody | undefined;
  const provider = createAnthropic({
    apiKey: "test-key",
    fetch: fakeFetch(async (_input: unknown, init?: { body?: unknown }) => {
      captured = JSON.parse(String(init?.body)) as WireBody;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  });
  await generateText({
    model: provider("claude-sonnet-4-5"),
    messages: coreMessages,
    allowSystemInMessages: true,
    tools,
  });
  if (captured === undefined) {
    throw new Error("the stub transport saw no request");
  }
  return captured;
}

function countBreakpoints(body: WireBody): number {
  return JSON.stringify(body).split('"cache_control"').length - 1;
}

function turnMessages(live: string) {
  return [
    systemMessage(live),
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi" },
    { role: "user" as const, content: "next" },
    { role: "user" as const, content: "context is at 72%", kind: "ephemeral" as const },
  ];
}

describe("Anthropic request shape", () => {
  it("caches the last tool, the stable system block and the conversation tail, nothing else", async () => {
    const body = await sendToAnthropic(
      toCoreMessages(turnMessages(LIVE_TEXT), "anthropic"),
      applyToolsCacheBreakpoint(buildTools(), "anthropic"),
    );

    expect(body.tools?.map((definition) => definition.cache_control !== undefined)).toEqual([
      false,
      false,
      true,
    ]);
    expect(body.system).toHaveLength(2);
    expect(body.system?.[0]?.text).toBe(STABLE_TEXT);
    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system?.[1]?.text).toBe(LIVE_TEXT);
    expect(body.system?.[1]?.cache_control).toBeUndefined();
    expect(countBreakpoints(body)).toBeLessThanOrEqual(MAX_ANTHROPIC_CACHE_BREAKPOINTS);
  });

  it("keeps the conversation breakpoint off the ephemeral nudge, as before the split", async () => {
    const body = await sendToAnthropic(
      toCoreMessages(turnMessages(LIVE_TEXT), "anthropic"),
      applyToolsCacheBreakpoint(buildTools(), "anthropic"),
    );

    const cachedMessages = body.messages.filter((message) =>
      message.content.some((part) => part.cache_control !== undefined),
    );
    expect(cachedMessages).toHaveLength(1);
    const cachedPart = cachedMessages[0]?.content.find((part) => part.cache_control !== undefined);
    expect(cachedPart?.text).toBe("next");
    expect(countBreakpoints(body)).toBe(3);
  });

  it("sends a prompt without a recorded prefix as one cached block", async () => {
    const body = await sendToAnthropic(
      toCoreMessages(
        [{ role: "system", content: `${STABLE_TEXT}${LIVE_TEXT}` }, ...turnMessages("").slice(1)],
        "anthropic",
      ),
      applyToolsCacheBreakpoint(buildTools(), "anthropic"),
    );

    expect(body.system).toHaveLength(1);
    expect(body.system?.[0]?.text).toBe(`${STABLE_TEXT}${LIVE_TEXT}`);
    expect(body.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("ignores a recorded prefix that no longer fits the content", () => {
    const user = { role: "user" as const, content: "hello" };
    const withPrefix = toCoreMessages(
      [{ role: "system", content: "short", stablePrefixLength: 500 }, user],
      "anthropic",
    );
    const withoutPrefix = toCoreMessages([{ role: "system", content: "short" }, user], "anthropic");

    expect(withPrefix).toEqual(withoutPrefix);
  });

  it("leaves a provider-defined tool last without a breakpoint on it", () => {
    const tools: ToolSet = {
      ...buildTools(),
      web_search: partialFake<ToolSet[string]>({
        type: "provider",
        id: "anthropic.web_search_20250305",
        args: {},
      }),
    };
    const result = applyToolsCacheBreakpoint(tools, "anthropic");

    expect(result["web_search"]).toBe(tools["web_search"]!);
    expect(result["mv"]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });
});

describe("two turns that differ only in live inputs", () => {
  it("send identical tools and an identical stable system block", async () => {
    const firstTurn = await sendToAnthropic(
      toCoreMessages(turnMessages(LIVE_TEXT), "anthropic"),
      applyToolsCacheBreakpoint(buildTools(), "anthropic"),
    );
    const secondTurn = await sendToAnthropic(
      toCoreMessages(
        turnMessages("\n\nEnvironment: Date: 2026-03-02\n\nPreferences: brief"),
        "anthropic",
      ),
      applyToolsCacheBreakpoint(buildTools(), "anthropic"),
    );

    expect(JSON.stringify(secondTurn.tools)).toBe(JSON.stringify(firstTurn.tools));
    expect(JSON.stringify(secondTurn.system?.[0])).toBe(JSON.stringify(firstTurn.system?.[0]));
    expect(secondTurn.system?.[1]?.text).not.toBe(firstTurn.system?.[1]?.text);
  });
});

describe("providers other than Anthropic", () => {
  const recordedMessages = fixture.messages as Parameters<typeof toCoreMessages>[0];

  it.each(fixture.requests.filter((request) => request.provider !== "anthropic"))(
    "$provider sends the same request content as before the split",
    ({ provider, expected }) => {
      const withPrefix = recordedMessages.map((message, index) =>
        index === 0 ? { ...message, stablePrefixLength: 18 } : message,
      );

      expect(
        JSON.parse(JSON.stringify(toCoreMessages(withPrefix, provider as ProviderName))),
      ).toEqual(expected);
      expect(
        JSON.parse(JSON.stringify(toCoreMessages(recordedMessages, provider as ProviderName))),
      ).toEqual(expected);
    },
  );

  it("anthropic without a recorded prefix sends the same request content as before the split", () => {
    const expected = fixture.requests.find((request) => request.provider === "anthropic")!.expected;

    expect(JSON.parse(JSON.stringify(toCoreMessages(recordedMessages, "anthropic")))).toEqual(
      expected,
    );
  });

  it("sends a single system message with the whole prompt", () => {
    const prompt = `${STABLE_TEXT}${LIVE_TEXT}`;
    for (const provider of ["openrouter", "ai_gateway", "openai", "ollama", "claude_code"]) {
      const converted = toCoreMessages(
        [systemMessage(LIVE_TEXT), { role: "user", content: "hello" }],
        provider as ProviderName,
      );
      const systemMessages = converted.filter((message) => message.role === "system");

      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]?.content).toBe(prompt);
    }
  });

  it("adds no tool breakpoint", () => {
    const tools = buildTools();

    for (const provider of ["openrouter", "ai_gateway", "openai", "ollama", "claude_code"]) {
      expect(applyToolsCacheBreakpoint(tools, provider)).toBe(tools);
    }
  });
});

describe("Anthropic tool tuple schemas", () => {
  it("serializes memory and scratchpad ranges as draft 2020-12 and retains validation", async () => {
    const tools: ToolSet = {};
    for (const definition of [createViewMemoryTool(), createViewWorkspaceTool()]) {
      const inputSchema = buildToolInputSchema({ function: definition }, undefined, "anthropic");
      tools[definition.name] = tool({ description: definition.description, inputSchema });
      expect((await inputSchema.validate?.({ view_range: [1, -1] }))?.success).toBe(true);
      expect((await inputSchema.validate?.({ view_range: [1] }))?.success).toBe(false);
      expect((await inputSchema.validate?.({ view_range: [1, "bad"] }))?.success).toBe(false);
      const unchanged = await buildToolInputSchema({ function: definition }, undefined, "openai")
        .jsonSchema;
      expect(unchanged).toMatchObject({
        properties: { view_range: { items: [{ type: "integer" }, { type: "integer" }] } },
      });
    }
    const body = await sendToAnthropic([{ role: "user", content: "hello" }], tools);
    expect(body.tools).toHaveLength(2);
    for (const advertised of body.tools ?? []) {
      expect(advertised.input_schema).toMatchObject({
        type: "object",
        properties: {
          view_range: {
            type: "array",
            prefixItems: [{ type: "integer" }, { type: "integer" }],
            items: false,
            minItems: 2,
            maxItems: 2,
          },
        },
      });
    }
  });

  it("also normalizes raw MCP schemas and top-level Zod unions", async () => {
    const tuple = z.tuple([z.string(), z.number()]);
    const parameters = z.object({ coordinates: tuple });
    const raw = {
      type: "object",
      properties: {
        coordinates: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
      },
    };
    const built = buildToolInputSchema(
      { function: { parameters, jsonSchema: raw } },
      undefined,
      "anthropic",
    );
    expect(await built.jsonSchema).toMatchObject({
      properties: {
        coordinates: { prefixItems: [{ type: "string" }, { type: "number" }], items: false },
      },
    });
    expect(raw.properties.coordinates.items).toHaveLength(2);
    const union = z.discriminatedUnion("command", [
      z.object({ command: z.literal("read"), range: tuple }),
      z.object({ command: z.literal("write"), range: tuple }),
    ]);
    expect(
      await buildToolInputSchema({ function: { parameters: union } }, undefined, "anthropic")
        .jsonSchema,
    ).toMatchObject({
      type: "object",
      properties: { range: { prefixItems: [{ type: "string" }, { type: "number" }] } },
    });
  });
});
