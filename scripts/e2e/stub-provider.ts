/**
 * A scripted OpenAI-compatible model server for end-to-end runs of `jazz run`.
 *
 * It speaks just enough of the vLLM surface for Jazz's `vllm` provider: `GET /v1/models`
 * and `POST /v1/chat/completions` (plain JSON or server-sent events). What the "model"
 * says is decided by a marker in the first user message, so a test chooses the scenario
 * in its prompt:
 *
 * - `[e2e:answer]`: answers `e2e answer` with no tool call.
 * - `[e2e:read path=<absolute path>]`: calls `read_file` on the path, then answers
 *   `read: <file contents>` from the tool result.
 * - `[e2e:shell command=<command>]`: calls `execute_command` with the command, then answers
 *   `ran: <tool result>`.
 * - `[e2e:fetch url=<url>]`: calls `web_fetch` on the URL, then answers `ran: <tool result>`.
 *
 * A request without tools is a side call (Jazz's command-risk classifier, or a summary);
 * it is answered `high-risk`, so an unallowlisted command never auto-approves by accident.
 *
 * Usage: `bun scripts/e2e/stub-provider.ts` prints `listening <port>` on stdout once it
 * accepts connections. Point Jazz at it with `VLLM_BASE_URL=http://127.0.0.1:<port>/v1`.
 */

/** The model id the server lists and answers as. */
export const STUB_MODEL_ID = "jazz-e2e-stub";

const STUB_CONTEXT_WINDOW = 32_768;

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

interface ChatRequest {
  readonly messages?: readonly ChatMessage[];
  readonly tools?: readonly unknown[];
  readonly stream?: boolean;
}

interface ScriptedTurn {
  readonly content: string;
  readonly toolCall?: { readonly name: string; readonly arguments: Record<string, unknown> };
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
      )
      .join("");
  }
  return "";
}

/** Decide the next assistant turn from the conversation so far. */
export function scriptTurn(request: ChatRequest): ScriptedTurn {
  const messages = request.messages ?? [];
  if (!request.tools || request.tools.length === 0) {
    return { content: "high-risk" };
  }

  const prompt = messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content))
    .join("\n");
  const toolResult = [...messages].reverse().find((message) => message.role === "tool");
  const marker = /\[e2e:(\w+)(?: (\w+)=([^\]]*))?\]/.exec(prompt);
  const scenario = marker?.[1];
  const argument = marker?.[3] ?? "";

  if (toolResult !== undefined) {
    const result = textOf(toolResult.content);
    return { content: scenario === "read" ? `read: ${result}` : `ran: ${result}` };
  }
  if (scenario === "read") {
    return { content: "", toolCall: { name: "read_file", arguments: { path: argument } } };
  }
  if (scenario === "fetch") {
    return { content: "", toolCall: { name: "web_fetch", arguments: { url: argument } } };
  }
  if (scenario === "shell") {
    return {
      content: "",
      toolCall: {
        name: "execute_command",
        arguments: { command: argument, description: "Run the e2e command" },
      },
    };
  }
  return { content: "e2e answer" };
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function completionBody(turn: ScriptedTurn): Record<string, unknown> {
  const toolCalls = turn.toolCall
    ? [
        {
          id: "call_e2e_1",
          type: "function",
          function: {
            name: turn.toolCall.name,
            arguments: JSON.stringify(turn.toolCall.arguments),
          },
        },
      ]
    : undefined;
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: STUB_MODEL_ID,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: turn.content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: USAGE,
  };
}

function streamBody(turn: ScriptedTurn): string {
  const base = {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: STUB_MODEL_ID,
  };
  const delta = turn.toolCall
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_e2e_1",
            type: "function",
            function: {
              name: turn.toolCall.name,
              arguments: JSON.stringify(turn.toolCall.arguments),
            },
          },
        ],
      }
    : { role: "assistant", content: turn.content };
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: turn.toolCall ? "tool_calls" : "stop" }],
    },
    { ...base, choices: [], usage: USAGE },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

export function startStubProvider(port = 0): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: STUB_MODEL_ID, object: "model", max_model_len: STUB_CONTEXT_WINDOW }],
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as ChatRequest;
        const turn = scriptTurn(body);
        if (body.stream === true) {
          return new Response(streamBody(turn), {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return Response.json(completionBody(turn));
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  const server = startStubProvider(Number(process.env["STUB_PORT"] ?? 0));
  process.stdout.write(`listening ${server.port}\n`);
}
