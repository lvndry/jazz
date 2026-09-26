/**
 * Talks to the ChatGPT Codex backend through the AI SDK's OpenAI Responses client.
 *
 * The backend speaks the Responses API with a few differences the SDK does not know about, all
 * absorbed here by a custom `fetch`: OAuth headers instead of an API key, a required top-level
 * `instructions`, no server-side storage (so no item references), no `max_output_tokens`, and
 * streaming only.
 */

import { getChatGPTCredential } from "./credentials";
import { CHATGPT_ORIGINATOR, type ChatGPTCredential } from "./oauth";

export const CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api";
/** What the Responses client is pointed at; it appends `/responses`. */
export const CHATGPT_CODEX_BASE_URL = `${CHATGPT_BACKEND_BASE_URL}/codex`;

/** The backend rejects a request without `instructions`; used only when there is no system prompt. */
const FALLBACK_INSTRUCTIONS = "You are a helpful assistant.";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The SDK sends the system prompt as `system`, or as `developer` for reasoning models. */
function isSystemItem(item: JsonObject): boolean {
  return (
    (item["type"] === undefined || item["type"] === "message") &&
    (item["role"] === "system" || item["role"] === "developer")
  );
}

function messageText(item: JsonObject): string {
  const content = item["content"];
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) && typeof part["text"] === "string" ? part["text"] : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

/**
 * Adapt a Responses request body for the Codex backend. Returns whether the caller asked for a
 * stream, because the backend is always asked for one.
 *
 * - The leading system or developer messages become `instructions`; later system messages become
 *   `developer` messages, the role the backend accepts mid-conversation.
 * - `store` is forced off, so item references and item ids (which point at stored items that do
 *   not exist) are dropped. Reasoning continuity rides on `reasoning.encrypted_content` instead.
 */
export function rewriteCodexRequestBody(body: JsonObject): {
  readonly body: JsonObject;
  readonly wantsStream: boolean;
} {
  const wantsStream = body["stream"] === true;
  const rewritten: JsonObject = { ...body, store: false, stream: true };
  delete rewritten["max_output_tokens"];
  delete rewritten["max_completion_tokens"];

  const input = Array.isArray(body["input"]) ? body["input"] : [];
  const instructions: string[] =
    typeof body["instructions"] === "string" && body["instructions"].length > 0
      ? [body["instructions"]]
      : [];
  const nextInput: unknown[] = [];
  let leading = true;
  for (const item of input) {
    if (!isObject(item)) {
      nextInput.push(item);
      continue;
    }
    if (item["type"] === "item_reference") {
      continue;
    }
    if (isSystemItem(item)) {
      if (leading) {
        const text = messageText(item);
        if (text.length > 0) {
          instructions.push(text);
        }
        continue;
      }
      const { id: _id, ...rest } = item;
      nextInput.push({ ...rest, role: "developer" });
      continue;
    }
    leading = false;
    const { id: _id, ...rest } = item;
    nextInput.push(rest);
  }
  rewritten["input"] = nextInput;
  rewritten["instructions"] =
    instructions.length > 0 ? instructions.join("\n\n") : FALLBACK_INSTRUCTIONS;

  if (isObject(body["reasoning"])) {
    const include: unknown[] = Array.isArray(body["include"]) ? body["include"] : [];
    if (!include.includes("reasoning.encrypted_content")) {
      rewritten["include"] = [...include, "reasoning.encrypted_content"];
    }
  }

  return { body: rewritten, wantsStream };
}

function parseEventStream(text: string): JsonObject[] {
  const events: JsonObject[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }
    try {
      const event: unknown = JSON.parse(data);
      if (isObject(event)) {
        events.push(event);
      }
    } catch {
      // A malformed line cannot carry the final response; skip it.
    }
  }
  return events;
}

const FINAL_EVENT_TYPES = new Set(["response.completed", "response.done", "response.incomplete"]);

/**
 * Reduce a Codex event stream to the single JSON body a non-streaming Responses call expects.
 *
 * The final event's `response` is the body. Its `output` is rebuilt from the
 * `response.output_item.done` events when the backend sends it empty.
 */
export function collapseEventStream(text: string): {
  readonly status: number;
  readonly body: JsonObject;
} {
  const events = parseEventStream(text);
  const doneItems: unknown[] = [];
  for (const event of events) {
    const type = event["type"];
    if (type === "response.output_item.done" && event["item"] !== undefined) {
      doneItems.push(event["item"]);
      continue;
    }
    if (typeof type === "string" && FINAL_EVENT_TYPES.has(type) && isObject(event["response"])) {
      const response = event["response"];
      const output = Array.isArray(response["output"]) ? response["output"] : [];
      return {
        status: 200,
        body:
          output.length > 0 || doneItems.length === 0
            ? response
            : { ...response, output: doneItems },
      };
    }
    if (type === "response.failed" || type === "error") {
      const failure = isObject(event["response"])
        ? event["response"]["error"]
        : (event["error"] ?? event);
      const message =
        isObject(failure) && typeof failure["message"] === "string"
          ? failure["message"]
          : "The ChatGPT backend reported a failure";
      const code =
        isObject(failure) && typeof failure["code"] === "string" ? failure["code"] : undefined;
      return {
        status: code === "usage_limit_reached" || code === "rate_limit_exceeded" ? 429 : 500,
        body: { error: { message, type: "server_error", ...(code !== undefined ? { code } : {}) } },
      };
    }
  }
  return {
    status: 502,
    body: {
      error: {
        message: "The ChatGPT backend closed the stream without a final response",
        type: "server_error",
      },
    },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function withChatGPTHeaders(
  headersInit: HeadersInit | undefined,
  credential: ChatGPTCredential,
): Headers {
  const headers = new Headers(headersInit);
  headers.set("authorization", `Bearer ${credential.access}`);
  headers.set("chatgpt-account-id", credential.accountId);
  headers.set("originator", CHATGPT_ORIGINATOR);
  return headers;
}

/**
 * A `fetch` that signs requests with the stored ChatGPT sign-in and adapts Responses calls for the
 * Codex backend. A 401 triggers one forced token refresh and a retry.
 */
export function createChatGPTFetch(options?: {
  readonly baseFetch?: typeof fetch;
  readonly getCredential?: typeof getChatGPTCredential;
}): typeof fetch {
  const baseFetch = options?.baseFetch ?? fetch;
  const getCredential = options?.getCredential ?? getChatGPTCredential;
  const chatgptFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    let body = init?.body;
    let wantsStream = true;
    const isResponsesCall = new URL(url).pathname.endsWith("/responses");

    if (isResponsesCall && typeof body === "string") {
      const parsed: unknown = JSON.parse(body);
      if (isObject(parsed)) {
        const rewritten = rewriteCodexRequestBody(parsed);
        body = JSON.stringify(rewritten.body);
        wantsStream = rewritten.wantsStream;
      }
    }

    const send = (credential: ChatGPTCredential): Promise<Response> => {
      const headers = withChatGPTHeaders(init?.headers, credential);
      if (isResponsesCall) {
        headers.set("OpenAI-Beta", "responses=experimental");
        headers.set("accept", "text/event-stream");
      }
      return baseFetch(url, { ...init, headers, ...(body !== undefined ? { body } : {}) });
    };

    let credential = await getCredential();
    let response = await send(credential);
    if (response.status === 401) {
      credential = await getCredential({ rejectedAccess: credential.access });
      response = await send(credential);
    }

    if (!isResponsesCall || wantsStream || !response.ok) {
      return response;
    }

    const collapsed = collapseEventStream(await response.text());
    return new Response(JSON.stringify(collapsed.body), {
      status: collapsed.status,
      headers: { "content-type": "application/json" },
    });
  };
  return chatgptFetch as typeof fetch;
}

/**
 * Codex CLI version reported to the model catalog. The backend hides models that need a newer
 * client than this, so it tracks a current Codex CLI release (0.157.0, September 2026).
 */
const CODEX_CLIENT_VERSION = "0.157.0";

/**
 * The catalog's context window scaled by `effective_context_window_percent`, the share the
 * backend leaves for input after reserving room for output.
 */
function usableContextWindow(model: JsonObject): number | undefined {
  const contextWindow = model["context_window"];
  if (typeof contextWindow !== "number" || contextWindow <= 0) {
    return undefined;
  }
  const percent = model["effective_context_window_percent"];
  return typeof percent === "number" && percent > 0 && percent <= 100
    ? Math.floor((contextWindow * percent) / 100)
    : contextWindow;
}

export interface ChatGPTModelEntry {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly isReasoningModel: boolean;
  readonly ingestImage: boolean;
}

/**
 * The models this ChatGPT plan can use, in the backend's own order, from the catalog the Codex
 * CLI reads. Hidden models are left out.
 */
export async function fetchChatGPTModels(
  chatgptFetch: typeof fetch = createChatGPTFetch(),
): Promise<ChatGPTModelEntry[]> {
  const response = await chatgptFetch(
    `${CHATGPT_CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error(`Failed to list ChatGPT models: ${response.status} ${response.statusText}`);
  }
  const data: unknown = await response.json();
  const models = isObject(data) && Array.isArray(data["models"]) ? data["models"] : [];
  return models
    .filter(isObject)
    .filter((model) => typeof model["slug"] === "string" && model["visibility"] === "list")
    .sort((left, right) => Number(left["priority"] ?? 0) - Number(right["priority"] ?? 0))
    .map((model) => {
      const contextWindow = usableContextWindow(model);
      const reasoningLevels = model["supported_reasoning_levels"];
      const modalities = model["input_modalities"];
      return {
        id: model["slug"] as string,
        displayName:
          typeof model["display_name"] === "string"
            ? model["display_name"]
            : (model["slug"] as string),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        isReasoningModel: Array.isArray(reasoningLevels) && reasoningLevels.length > 0,
        // An omitted list means text and images, matching the Codex CLI's own default.
        ingestImage: Array.isArray(modalities) ? modalities.includes("image") : true,
      };
    });
}
