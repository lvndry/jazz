import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, streamText } from "ai";
import { describe, expect, it } from "bun:test";
import { toCoreMessages } from "../ai-sdk-service";
import { extractReasoningParts } from "../reasoning-parts";
import type { ChatGPTCredential } from "./oauth";
import {
  CHATGPT_CODEX_BASE_URL,
  collapseEventStream,
  createChatGPTFetch,
  fetchChatGPTModels,
  rewriteCodexRequestBody,
} from "./transport";

const credential: ChatGPTCredential = {
  access: "access-1",
  refresh: "refresh-1",
  expires: Date.now() + 3_600_000,
  accountId: "account-1",
};

function eventStream(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const completedResponse = {
  id: "resp_1",
  object: "response",
  created_at: 1_700_000_000,
  model: "gpt-5.5",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello from codex", annotations: [] }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
};

const streamEvents = [
  {
    type: "response.created",
    response: { ...completedResponse, status: "in_progress", output: [] },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "hello from codex",
  },
  { type: "response.output_item.done", output_index: 0, item: completedResponse.output[0] },
  { type: "response.completed", response: completedResponse },
];

interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function fakeBackend(respond: (request: RecordedRequest) => Response): {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const backendFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { fetch: backendFetch, requests };
}

function sseResponse(events: readonly unknown[]): Response {
  return new Response(eventStream(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("rewriteCodexRequestBody", () => {
  it("moves leading system messages into instructions and demotes later ones to developer", () => {
    const { body, wantsStream } = rewriteCodexRequestBody({
      model: "gpt-5.5",
      stream: false,
      max_output_tokens: 1000,
      input: [
        { role: "system", content: "You are Jazz." },
        { role: "system", content: [{ type: "input_text", text: "Be brief." }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "system", content: "Reminder: the user prefers metric units." },
      ],
    });

    expect(wantsStream).toBe(false);
    expect(body["stream"]).toBe(true);
    expect(body["store"]).toBe(false);
    expect(body["max_output_tokens"]).toBeUndefined();
    expect(body["instructions"]).toBe("You are Jazz.\n\nBe brief.");
    expect(body["input"]).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "developer", content: "Reminder: the user prefers metric units." },
    ]);
  });

  it("treats a leading developer message, the SDK's system role for reasoning models, as instructions", () => {
    const { body } = rewriteCodexRequestBody({
      input: [
        { role: "developer", content: "You are Jazz." },
        { role: "user", content: "hi" },
      ],
    });
    expect(body["instructions"]).toBe("You are Jazz.");
    expect(body["input"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("drops item references and item ids, which point at storage the backend does not keep", () => {
    const { body } = rewriteCodexRequestBody({
      input: [
        { role: "user", content: "hi" },
        { type: "item_reference", id: "rs_1" },
        { type: "reasoning", id: "rs_2", encrypted_content: "opaque", summary: [] },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: "{}",
        },
      ],
    });

    expect(body["input"]).toEqual([
      { role: "user", content: "hi" },
      { type: "reasoning", encrypted_content: "opaque", summary: [] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
    ]);
  });

  it("falls back to default instructions when there is no system prompt", () => {
    const { body } = rewriteCodexRequestBody({ input: [{ role: "user", content: "hi" }] });
    expect(typeof body["instructions"]).toBe("string");
    expect((body["instructions"] as string).length).toBeGreaterThan(0);
  });

  it("asks for encrypted reasoning when reasoning is on", () => {
    const { body } = rewriteCodexRequestBody({
      input: [],
      reasoning: { effort: "high" },
      include: ["web_search_call.action.sources"],
    });
    expect(body["include"]).toEqual([
      "web_search_call.action.sources",
      "reasoning.encrypted_content",
    ]);
  });
});

describe("collapseEventStream", () => {
  it("returns the final response", () => {
    const collapsed = collapseEventStream(eventStream(streamEvents));
    expect(collapsed.status).toBe(200);
    expect(collapsed.body).toEqual(completedResponse);
  });

  it("rebuilds output from finished items when the final event carries none", () => {
    const events = [
      { type: "response.output_item.done", output_index: 0, item: completedResponse.output[0] },
      { type: "response.completed", response: { ...completedResponse, output: [] } },
    ];
    expect(collapseEventStream(eventStream(events)).body["output"]).toEqual(
      completedResponse.output,
    );
  });

  it("maps a usage-limit failure to 429", () => {
    const collapsed = collapseEventStream(
      eventStream([
        {
          type: "response.failed",
          response: {
            error: { code: "usage_limit_reached", message: "You've hit your usage limit." },
          },
        },
      ]),
    );
    expect(collapsed.status).toBe(429);
    expect(collapsed.body).toEqual({
      error: {
        message: "You've hit your usage limit.",
        type: "server_error",
        code: "usage_limit_reached",
      },
    });
  });

  it("reports a stream that ends without a final event", () => {
    expect(collapseEventStream(eventStream(streamEvents.slice(0, 2))).status).toBe(502);
  });
});

describe("createChatGPTFetch", () => {
  it("signs requests with the ChatGPT account instead of an API key", async () => {
    const backend = fakeBackend(() => sseResponse(streamEvents));
    const chatgptFetch = createChatGPTFetch({
      baseFetch: backend.fetch,
      getCredential: () => Promise.resolve(credential),
    });

    await chatgptFetch(`${CHATGPT_CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer placeholder" },
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: [] }),
    });

    const headers = backend.requests[0]!.headers;
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.get("chatgpt-account-id")).toBe("account-1");
    expect(headers.get("originator")).toBe("jazz");
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  it("refreshes once and retries when the backend rejects the token", async () => {
    let calls = 0;
    const backend = fakeBackend(() => {
      calls += 1;
      return calls === 1 ? new Response("expired", { status: 401 }) : sseResponse(streamEvents);
    });
    const rejected: (string | undefined)[] = [];
    const chatgptFetch = createChatGPTFetch({
      baseFetch: backend.fetch,
      getCredential: (options) => {
        rejected.push(options?.rejectedAccess);
        return Promise.resolve(
          options?.rejectedAccess === undefined
            ? credential
            : { ...credential, access: "access-2" },
        );
      },
    });

    const response = await chatgptFetch(`${CHATGPT_CODEX_BASE_URL}/responses`, {
      method: "POST",
      body: JSON.stringify({ stream: true, input: [] }),
    });

    expect(response.status).toBe(200);
    expect(rejected).toEqual([undefined, "access-1"]);
    expect(backend.requests[1]!.headers.get("authorization")).toBe("Bearer access-2");
  });
});

describe("AI SDK through the ChatGPT fetch", () => {
  function codexModel(backendFetch: typeof fetch) {
    return createOpenAI({
      apiKey: "chatgpt-oauth",
      baseURL: CHATGPT_CODEX_BASE_URL,
      fetch: createChatGPTFetch({
        baseFetch: backendFetch,
        getCredential: () => Promise.resolve(credential),
      }),
    }).responses("gpt-5.5");
  }

  it("serves generateText from the event stream the backend always sends", async () => {
    const backend = fakeBackend(() => sseResponse(streamEvents));

    const result = await generateText({
      model: codexModel(backend.fetch),
      system: "You are Jazz.",
      prompt: "Say hello",
      maxOutputTokens: 500,
    });

    expect(result.text).toBe("hello from codex");
    const sent = backend.requests[0]!;
    expect(sent.url).toBe(`${CHATGPT_CODEX_BASE_URL}/responses`);
    expect(sent.body["stream"]).toBe(true);
    expect(sent.body["store"]).toBe(false);
    expect(sent.body["instructions"]).toBe("You are Jazz.");
    expect(sent.body["max_output_tokens"]).toBeUndefined();
  });

  it("streams text deltas", async () => {
    const backend = fakeBackend(() => sseResponse(streamEvents));

    const result = streamText({ model: codexModel(backend.fetch), prompt: "Say hello" });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }

    expect(text).toBe("hello from codex");
  });
});

describe("fetchChatGPTModels", () => {
  it("lists visible models in the backend's order with their usable context window", async () => {
    const catalogFetch = (async () =>
      Response.json({
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
            priority: 2,
            context_window: 272_000,
            effective_context_window_percent: 95,
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          { slug: "internal-model", display_name: "Internal", visibility: "hide", priority: 0 },
          {
            slug: "gpt-5.3-codex-spark",
            display_name: "GPT-5.3 Codex Spark",
            visibility: "list",
            priority: 1,
            context_window: 128_000,
            supported_reasoning_levels: [],
            input_modalities: ["text"],
          },
        ],
      })) as unknown as typeof fetch;

    const models = await fetchChatGPTModels(catalogFetch);

    expect(models).toEqual([
      {
        id: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3 Codex Spark",
        contextWindow: 128_000,
        isReasoningModel: false,
        ingestImage: false,
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        contextWindow: 258_400,
        isReasoningModel: true,
        ingestImage: true,
      },
    ]);
  });
});

describe("reasoning across tool calls", () => {
  function toolCallTurn(callNumber: number): unknown[] {
    const reasoning = {
      type: "reasoning",
      id: `rs_${callNumber}`,
      encrypted_content: `encrypted-${callNumber}`,
      summary: [{ type: "summary_text", text: `plan ${callNumber}` }],
    };
    const call = {
      type: "function_call",
      id: `fc_${callNumber}`,
      call_id: `call_${callNumber}`,
      name: "read_file",
      arguments: JSON.stringify({ path: `file-${callNumber}.txt` }),
      status: "completed",
    };
    const response = { ...completedResponse, id: `resp_${callNumber}`, output: [reasoning, call] };
    return [
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response },
    ];
  }

  it("sends every earlier call's encrypted reasoning back to the backend", async () => {
    let callNumber = 0;
    const backend = fakeBackend(() => {
      callNumber += 1;
      return sseResponse(callNumber <= 2 ? toolCallTurn(callNumber) : streamEvents);
    });
    const model = createOpenAI({
      apiKey: "chatgpt-oauth",
      baseURL: CHATGPT_CODEX_BASE_URL,
      fetch: createChatGPTFetch({
        baseFetch: backend.fetch,
        getCredential: () => Promise.resolve(credential),
      }),
    }).responses("gpt-5.5");
    const tools = {
      read_file: { description: "Read a file", inputSchema: jsonSchema({ type: "object" }) },
    };
    const providerOptions = {
      openai: { store: false, include: ["reasoning.encrypted_content"], reasoningEffort: "high" },
    };

    type JazzMessage = Parameters<typeof toCoreMessages>[0][number];
    const history: JazzMessage[] = [
      { role: "system", content: "You are Jazz." },
      { role: "user", content: "Compare two files" },
    ];

    for (let step = 1; step <= 2; step++) {
      const result = await generateText({
        model,
        messages: toCoreMessages(history, "chatgpt"),
        allowSystemInMessages: true,
        tools,
        providerOptions,
      });
      const toolCall = result.toolCalls[0]!;
      const reasoningParts = extractReasoningParts(result.response.messages, "chatgpt");
      history.push(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: toolCall.toolCallId,
              type: "function",
              function: { name: toolCall.toolName, arguments: JSON.stringify(toolCall.input) },
            },
          ],
          ...(reasoningParts ? { reasoning_parts: reasoningParts } : {}),
        },
        { role: "tool", content: `contents of file ${step}`, tool_call_id: toolCall.toolCallId },
      );
    }

    await generateText({
      model,
      messages: toCoreMessages(history, "chatgpt"),
      allowSystemInMessages: true,
      tools,
      providerOptions,
    });

    const finalInput = backend.requests[2]!.body["input"] as Array<Record<string, unknown>>;
    expect(finalInput.map((item) => item["type"] ?? item["role"])).toEqual([
      "user",
      "reasoning",
      "function_call",
      "function_call_output",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(
      finalInput
        .filter((item) => item["type"] === "reasoning")
        .map((item) => item["encrypted_content"]),
    ).toEqual(["encrypted-1", "encrypted-2"]);
    expect(finalInput.some((item) => item["id"] !== undefined)).toBe(false);
  });
});
