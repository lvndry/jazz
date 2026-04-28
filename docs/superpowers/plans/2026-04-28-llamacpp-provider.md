# llama.cpp Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `llamacpp` as a first-class LLM provider that talks to a user-managed `llama-server` over its OpenAI-compatible `/v1` API, with auto-detected context window and tool-calling support from `/props`. As an adjacent improvement, make Ollama's base URL configurable.

**Architecture:** A new `llamacpp` provider registered alongside `ollama`. Inference goes through Vercel AI SDK's `@ai-sdk/openai-compatible` adapter; model discovery hits `GET /v1/models` and `GET /props` (one call each per fetch). A shared `resolveLocalProviderBaseUrl()` helper unifies base-URL resolution (config → env → default) for both `llamacpp` and `ollama`.

**Tech Stack:** TypeScript, Effect-TS, Bun (test runner: `bun:test`), Vercel AI SDK, new dep `@ai-sdk/openai-compatible`.

**Spec:** [`docs/superpowers/specs/2026-04-28-llamacpp-design.md`](../specs/2026-04-28-llamacpp-design.md)

---

## File Structure

| Path | Role |
|---|---|
| `src/core/constants/models.ts` | Source of truth for `ProviderName` — add `llamacpp` here. |
| `src/core/utils/string.ts` | Display-name map — add llama.cpp brand. |
| `src/core/types/config.ts` | Typed config shapes — add `LlamaCppProviderConfig`, extend `OllamaProviderConfig.base_url`. |
| `src/services/llm/models.ts` | Provider registry + `resolveLocalProviderBaseUrl()` helper + `DEFAULT_LLAMACPP_BASE_URL`. |
| `src/services/llm/base-url-resolver.test.ts` | New — covers resolver precedence. |
| `src/services/llm/ai-sdk-service.ts` | `selectModel()` and `getConfiguredProviders()` wiring. |
| `src/services/llm/ai-sdk-service.test.ts` | Extend with llamacpp + base-URL tests. |
| `src/services/llm/model-fetcher.ts` | New `transformLlamaCppModels()` and `fetchLlamaCppProps()`. |
| `src/services/llm/model-fetcher.test.ts` | Extend with llamacpp fetch cases. |
| `src/cli/commands/create-agent.ts` | Mark `llamacpp` API key as optional in setup wizard. |
| `docs/integrations/index.md` | Provider docs — add llama.cpp section, update Ollama. |
| `README.md` | Add llama.cpp to provider list. |

---

## Task 1: Register `llamacpp` in provider constants

**Files:**
- Modify: `src/core/constants/models.ts`
- Modify: `src/core/utils/string.ts`

- [ ] **Step 1: Add `llamacpp: []` to `STATIC_PROVIDER_MODELS`**

In `src/core/constants/models.ts`, inside `STATIC_PROVIDER_MODELS`, after the `ollama: []` entry (around line 112), add:

```ts
  llamacpp: [],
```

This automatically extends `ProviderName` and `AVAILABLE_PROVIDERS`.

- [ ] **Step 2: Add display name**

In `src/core/utils/string.ts`, inside `PROVIDER_DISPLAY_NAMES` (around line 107), add an entry. Keys must stay in alphabetical order:

```ts
  llamacpp: "llama.cpp",
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: clean. Errors here mean another file pattern-matches on `ProviderName` exhaustively and needs the new arm — fix at the next steps before commit.

- [ ] **Step 4: Commit**

```bash
git add src/core/constants/models.ts src/core/utils/string.ts
git commit -m "feat(llm): register llamacpp provider name and display name"
```

---

## Task 2: Add typed config shape

**Files:**
- Modify: `src/core/types/config.ts:73-94`

- [ ] **Step 1: Add `LlamaCppProviderConfig` and extend `OllamaProviderConfig`**

Replace the block from `OllamaProviderConfig` through `LLMConfig` with:

```ts
export interface OllamaProviderConfig {
  readonly api_key?: string;
  readonly base_url?: string;
}

export interface LlamaCppProviderConfig {
  readonly api_key?: string;
  readonly base_url?: string;
}

export interface LLMConfig {
  readonly ai_gateway?: LLMProviderConfig;
  readonly alibaba?: LLMProviderConfig;
  readonly anthropic?: LLMProviderConfig;
  readonly cerebras?: LLMProviderConfig;
  readonly deepseek?: LLMProviderConfig;
  readonly fireworks?: LLMProviderConfig;
  readonly google?: LLMProviderConfig;
  readonly groq?: LLMProviderConfig;
  readonly llamacpp?: LlamaCppProviderConfig;
  readonly minimax?: LLMProviderConfig;
  readonly mistral?: LLMProviderConfig;
  readonly moonshotai?: LLMProviderConfig;
  readonly ollama?: OllamaProviderConfig;
  readonly openai?: LLMProviderConfig;
  readonly openrouter?: LLMProviderConfig;
  readonly togetherai?: LLMProviderConfig;
  readonly xai?: LLMProviderConfig;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/core/types/config.ts
git commit -m "feat(config): add LlamaCppProviderConfig and Ollama base_url override"
```

---

## Task 3: Install `@ai-sdk/openai-compatible`

**Files:**
- Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Add dependency**

Run: `bun add @ai-sdk/openai-compatible`
Expected: `package.json` and `bun.lock` updated. Install completes without warnings.

- [ ] **Step 2: Verify import works**

Run a quick smoke check from the repo root:

```bash
bun -e "import('@ai-sdk/openai-compatible').then(m => console.log(typeof m.createOpenAICompatible))"
```
Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "feat(deps): add @ai-sdk/openai-compatible for llama.cpp provider"
```

---

## Task 4: Base URL resolver — failing tests

**Files:**
- Create: `src/services/llm/base-url-resolver.test.ts`

- [ ] **Step 1: Write failing tests for `resolveLocalProviderBaseUrl`**

Create `src/services/llm/base-url-resolver.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LLMConfig } from "@/core/types";
import { resolveLocalProviderBaseUrl } from "./models";

describe("resolveLocalProviderBaseUrl", () => {
  const ENV_VARS = ["LLAMACPP_BASE_URL", "OLLAMA_BASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of ENV_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("returns the llamacpp default when nothing configured", () => {
    expect(resolveLocalProviderBaseUrl("llamacpp")).toBe("http://localhost:8080/v1");
  });

  it("returns the ollama default when nothing configured", () => {
    expect(resolveLocalProviderBaseUrl("ollama")).toBe("http://localhost:11434/api");
  });

  it("uses LLAMACPP_BASE_URL env var over default", () => {
    process.env["LLAMACPP_BASE_URL"] = "http://env-host:9000/v1";
    expect(resolveLocalProviderBaseUrl("llamacpp")).toBe("http://env-host:9000/v1");
  });

  it("uses OLLAMA_BASE_URL env var over default", () => {
    process.env["OLLAMA_BASE_URL"] = "http://env-host:11434/api";
    expect(resolveLocalProviderBaseUrl("ollama")).toBe("http://env-host:11434/api");
  });

  it("config base_url overrides env var for llamacpp", () => {
    process.env["LLAMACPP_BASE_URL"] = "http://env-host:9000/v1";
    const config: LLMConfig = { llamacpp: { base_url: "http://config-host:9090/v1" } };
    expect(resolveLocalProviderBaseUrl("llamacpp", config)).toBe("http://config-host:9090/v1");
  });

  it("config base_url overrides env var for ollama", () => {
    process.env["OLLAMA_BASE_URL"] = "http://env-host:11434/api";
    const config: LLMConfig = { ollama: { base_url: "http://config-host:11434/api" } };
    expect(resolveLocalProviderBaseUrl("ollama", config)).toBe("http://config-host:11434/api");
  });

  it("ignores empty string config values and falls through", () => {
    const config: LLMConfig = { llamacpp: { base_url: "" } };
    expect(resolveLocalProviderBaseUrl("llamacpp", config)).toBe("http://localhost:8080/v1");
  });
});
```

- [ ] **Step 2: Run tests — expect them to fail**

Run: `bun test src/services/llm/base-url-resolver.test.ts`
Expected: FAIL — `resolveLocalProviderBaseUrl` is not exported from `./models`.

---

## Task 5: Implement `resolveLocalProviderBaseUrl` and register llamacpp

**Files:**
- Modify: `src/services/llm/models.ts`

- [ ] **Step 1: Add constants, registry entry, and resolver**

Replace the contents of `src/services/llm/models.ts` with:

```ts
import {
  STATIC_PROVIDER_MODELS,
  type ProviderName,
  type StaticModelEntry,
} from "@/core/constants/models";
import type { LLMConfig } from "@/core/types/config";

/**
 * This type represents how models are fetched for each provider.
 * Static models come from core constants (just IDs + displayName); metadata resolved via models.dev.
 * Dynamic models are fetched from provider API endpoints.
 */
export type ModelSource =
  | { type: "static"; models: readonly StaticModelEntry[] }
  | { type: "dynamic"; endpointPath: string; defaultBaseUrl?: string };

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/api";
export const DEFAULT_LLAMACPP_BASE_URL = "http://localhost:8080/v1";

export const PROVIDER_MODELS: Record<ProviderName, ModelSource> = {
  anthropic: { type: "static", models: STATIC_PROVIDER_MODELS.anthropic },
  openai: { type: "static", models: STATIC_PROVIDER_MODELS.openai },
  google: { type: "static", models: STATIC_PROVIDER_MODELS.google },
  xai: { type: "static", models: STATIC_PROVIDER_MODELS.xai },
  openrouter: {
    type: "dynamic",
    endpointPath: "/api/v1/models",
    defaultBaseUrl: "https://openrouter.ai",
  },
  ai_gateway: { type: "dynamic", endpointPath: "" },
  alibaba: { type: "static", models: STATIC_PROVIDER_MODELS.alibaba },
  cerebras: {
    type: "dynamic",
    endpointPath: "/v1/models",
    defaultBaseUrl: "https://api.cerebras.ai",
  },
  deepseek: { type: "static", models: STATIC_PROVIDER_MODELS.deepseek },
  fireworks: {
    type: "dynamic",
    endpointPath: "/v1/accounts/fireworks/models?pageSize=200",
    defaultBaseUrl: "https://api.fireworks.ai",
  },
  groq: {
    type: "dynamic",
    endpointPath: "/models",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
  },
  minimax: { type: "static", models: STATIC_PROVIDER_MODELS.minimax },
  mistral: { type: "static", models: STATIC_PROVIDER_MODELS.mistral },
  moonshotai: { type: "static", models: STATIC_PROVIDER_MODELS.moonshotai },
  ollama: { type: "dynamic", endpointPath: "/tags", defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL },
  llamacpp: {
    type: "dynamic",
    endpointPath: "/models",
    defaultBaseUrl: DEFAULT_LLAMACPP_BASE_URL,
  },
  togetherai: {
    type: "dynamic",
    endpointPath: "/v1/models",
    defaultBaseUrl: "https://api.together.xyz",
  },
} as const;

/**
 * Resolve the base URL for a local-server provider. Precedence:
 *   1. llmConfig.<provider>.base_url
 *   2. <PROVIDER>_BASE_URL env var
 *   3. PROVIDER_MODELS[<provider>].defaultBaseUrl
 */
export function resolveLocalProviderBaseUrl(
  provider: "llamacpp" | "ollama",
  llmConfig?: LLMConfig,
): string {
  const fromConfig = llmConfig?.[provider]?.base_url;
  if (fromConfig && fromConfig.length > 0) return fromConfig;

  const envVar = provider === "llamacpp" ? "LLAMACPP_BASE_URL" : "OLLAMA_BASE_URL";
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const fallback = PROVIDER_MODELS[provider].defaultBaseUrl;
  // PROVIDER_MODELS guarantees a defaultBaseUrl for both local providers above.
  return fallback ?? "";
}
```

- [ ] **Step 2: Run resolver tests — expect them to pass**

Run: `bun test src/services/llm/base-url-resolver.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/services/llm/models.ts src/services/llm/base-url-resolver.test.ts
git commit -m "feat(llm): add llamacpp provider registry entry and base-URL resolver"
```

---

## Task 6: Wire `selectModel` for llamacpp and route Ollama through resolver

**Files:**
- Modify: `src/services/llm/ai-sdk-service.ts`

- [ ] **Step 1: Add `@ai-sdk/openai-compatible` import and `llamacpp` env var**

In `src/services/llm/ai-sdk-service.ts`, after the existing `import { createOllama, ... }` line (around line 62), add:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
```

In the same file, replace the `import { DEFAULT_OLLAMA_BASE_URL, PROVIDER_MODELS }` line with:

```ts
import { DEFAULT_OLLAMA_BASE_URL, PROVIDER_MODELS, resolveLocalProviderBaseUrl } from "./models";
```

Then in `PROVIDER_ENV_VARS` (around line 356), add the `llamacpp` line in alphabetical order (between `groq` and `minimax`):

```ts
  llamacpp: "LLAMACPP_API_KEY",
```

- [ ] **Step 2: Update Ollama branch in `selectModel` to use resolver**

Replace the existing `case "ollama"` block (around lines 516-523) with:

```ts
    case "ollama": {
      const headers = llmConfig?.ollama?.api_key
        ? { Authorization: `Bearer ${llmConfig.ollama.api_key}` }
        : {};
      const baseURL = resolveLocalProviderBaseUrl("ollama", llmConfig);
      const ollamaInstance = createOllama({ baseURL, headers });
      model = ollamaInstance(modelId);
      break;
    }
```

- [ ] **Step 3: Add `llamacpp` branch in `selectModel`**

Add a new case immediately after the `case "ollama"` block:

```ts
    case "llamacpp": {
      const apiKey = llmConfig?.llamacpp?.api_key;
      const baseURL = resolveLocalProviderBaseUrl("llamacpp", llmConfig);
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
      const llamacpp = createOpenAICompatible({
        name: "llamacpp",
        baseURL,
        ...(headers ? { headers } : {}),
      });
      model = llamacpp(modelId);
      break;
    }
```

- [ ] **Step 4: Make llamacpp always-available like Ollama**

Replace the block (around lines 457-460):

```ts
  // Ollama is always available (no API key required)
  if (!addedProviders.has("ollama")) {
    providers.push({ name: "ollama", apiKey: llmConfig?.ollama?.api_key ?? "" });
  }
```

with:

```ts
  // Local-server providers are always available (no API key required)
  if (!addedProviders.has("ollama")) {
    providers.push({ name: "ollama", apiKey: llmConfig?.ollama?.api_key ?? "" });
  }
  if (!addedProviders.has("llamacpp")) {
    providers.push({ name: "llamacpp", apiKey: llmConfig?.llamacpp?.api_key ?? "" });
  }
```

- [ ] **Step 5: Loosen the `authenticate` API-key requirement for llamacpp**

In `getProvider` (around line 852), replace:

```ts
              if (providerName.toLowerCase() === "ollama") {
                return Effect.succeed(void 0);
              }
```

with:

```ts
              const lower = providerName.toLowerCase();
              if (lower === "ollama" || lower === "llamacpp") {
                return Effect.succeed(void 0);
              }
```

- [ ] **Step 6: Verify typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/llm/ai-sdk-service.ts
git commit -m "feat(llm): wire llamacpp provider into selectModel and route Ollama through resolver"
```

---

## Task 7: Add ai-sdk-service tests for llamacpp

**Files:**
- Modify: `src/services/llm/ai-sdk-service.test.ts`

- [ ] **Step 1: Add `llamacpp` to "list all providers" coverage**

In `src/services/llm/ai-sdk-service.test.ts`, find the test starting around line 67 (`"should list all providers with correct configured status"`). After the `expect(providerNames).toContain("ollama");` line, add:

```ts
      expect(providerNames).toContain("llamacpp");
```

- [ ] **Step 2: Add a test asserting llamacpp is always-available**

Locate the existing `"should mark Ollama as configured even without API key"` test (around line 97). Right after that test's closing brace, add a new test:

```ts
    it("should mark llamacpp as configured even without API key", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.listProviders();
      });

      const configLayer = createTestConfigLayer({});
      const result = await runWithTestLayers(testEffect, configLayer);

      const llamacpp = result.find((p) => p.name === "llamacpp");
      expect(llamacpp).toBeDefined();
      expect(llamacpp?.configured).toBe(true);
    });
```

- [ ] **Step 3: Run the new tests**

Run: `bun test src/services/llm/ai-sdk-service.test.ts`
Expected: PASS — including the two newly affected cases.

- [ ] **Step 4: Commit**

```bash
git add src/services/llm/ai-sdk-service.test.ts
git commit -m "test(llm): cover llamacpp in provider listing and always-available behavior"
```

---

## Task 8: Failing tests for llama.cpp model fetcher

**Files:**
- Modify: `src/services/llm/model-fetcher.test.ts`

- [ ] **Step 1: Add llama.cpp test cases**

In `src/services/llm/model-fetcher.test.ts`, before the closing `});` of the `describe("ModelFetcher", …)` block, add:

```ts
  it("fetches llama.cpp models with /v1/models + /props (happy path)", async () => {
    const modelsResponse = { data: [{ id: "qwen2.5-coder-32b" }] };
    const propsResponse = {
      default_generation_settings: { n_ctx: 32768 },
      chat_template_caps: { supports_tools: true, supports_tool_calls: true },
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(modelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(propsResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("qwen2.5-coder-32b");
    expect(result[0]!.contextWindow).toBe(32768);
    expect(result[0]!.supportsTools).toBe(true);
  });

  it("falls back to defaults when llama.cpp /props is unreachable", async () => {
    const modelsResponse = { data: [{ id: "tinyllama" }] };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(modelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromise(program);

    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe("tinyllama");
    expect(result[0]!.contextWindow).toBe(128_000);
    expect(result[0]!.supportsTools).toBe(false);
  });

  it("requires both supports_tools and supports_tool_calls in chat_template_caps", async () => {
    const modelsResponse = { data: [{ id: "partial-tools" }] };
    const propsResponse = {
      default_generation_settings: { n_ctx: 4096 },
      chat_template_caps: { supports_tools: true, supports_tool_calls: false },
    };

    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(modelsResponse) });
      if (url.endsWith("/props"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(propsResponse) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromise(program);

    expect(result[0]!.supportsTools).toBe(false);
    expect(result[0]!.contextWindow).toBe(4096);
  });

  it("returns a friendly error when llama.cpp has no model loaded", async () => {
    global.fetch = mock((url: string) => {
      if (url.endsWith("/v1/models"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.reject("Unknown URL");
    }) as unknown as typeof fetch;

    const program = fetcher.fetchModels("llamacpp", "http://localhost:8080/v1", "/models");
    const result = await Effect.runPromiseExit(program);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const msg = String(result.cause);
      expect(msg).toMatch(/no models loaded|llama-server/i);
    }
  });
```

- [ ] **Step 2: Run tests — expect failures**

Run: `bun test src/services/llm/model-fetcher.test.ts`
Expected: FAIL — fetcher has no `llamacpp` branch yet, all four new tests fail (likely with "No list extractor found" or returning empty arrays).

---

## Task 9: Implement llama.cpp model fetcher branch

**Files:**
- Modify: `src/services/llm/model-fetcher.ts`

- [ ] **Step 1: Add types and `/props` fetcher**

In `src/services/llm/model-fetcher.ts`, after the existing `OllamaShowResponse` type block (around line 92), add:

```ts
type LlamaCppModelEntry = { id: string };
type LlamaCppModelsResponse = { data?: LlamaCppModelEntry[] };
type LlamaCppPropsResponse = {
  default_generation_settings?: { n_ctx?: number };
  chat_template_caps?: Record<string, boolean>;
};

/**
 * Strip a trailing `/v1` (or `/v1/`) from a llama-server base URL so we can
 * reach the server-root `/props` endpoint. `/props` lives at the root, not
 * under `/v1`.
 */
function llamaCppServerRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

async function fetchLlamaCppProps(
  baseUrl: string,
): Promise<LlamaCppPropsResponse | undefined> {
  try {
    const response = await fetch(`${llamaCppServerRoot(baseUrl)}/props`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) return undefined;
    return (await response.json()) as LlamaCppPropsResponse;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: Add `transformLlamaCppModels`**

After the existing `transformOllamaModels` function (around line 293), add:

```ts
/**
 * llama.cpp: list from /v1/models, enrich via /props once.
 *  - contextWindow: props.default_generation_settings.n_ctx (else DEFAULT_CONTEXT_WINDOW)
 *  - supportsTools: props.chat_template_caps.supports_tools && supports_tool_calls
 *    (both required; populated by jinja::caps when llama-server runs with --jinja)
 */
async function transformLlamaCppModels(
  data: unknown,
  baseUrl: string,
  modelsDevMap: Map<string, ModelsDevMetadata> | null,
): Promise<ModelInfo[]> {
  const response = data as LlamaCppModelsResponse;
  const models = response.data ?? [];
  if (models.length === 0) {
    throw new Error(
      "No models loaded. Start `llama-server` with `-m <path>.gguf` first.",
    );
  }

  const props = await fetchLlamaCppProps(baseUrl);
  const ctx = props?.default_generation_settings?.n_ctx;
  const caps = props?.chat_template_caps ?? {};
  const supportsTools = caps["supports_tools"] === true && caps["supports_tool_calls"] === true;

  return models.map((model) => {
    const entry: RawModelEntry = { id: model.id, displayName: model.id };
    const dev = getMetadataFromMap(modelsDevMap, model.id);
    if (dev) return resolveToModelInfo(entry, modelsDevMap);
    entry.fallback = {
      contextWindow: ctx ?? DEFAULT_CONTEXT_WINDOW,
      supportsTools,
      isReasoningModel: false,
    };
    return resolveToModelInfo(entry, null);
  });
}
```

- [ ] **Step 3: Wire the branch into `createModelFetcher`**

In `createModelFetcher()` (around line 337), find the block:

```ts
          if (providerName === "ollama") {
            return transformOllamaModels(data, baseUrl, modelsDevMap);
          }
```

Replace it with:

```ts
          if (providerName === "ollama") {
            return transformOllamaModels(data, baseUrl, modelsDevMap);
          }

          if (providerName === "llamacpp") {
            return transformLlamaCppModels(data, baseUrl, modelsDevMap);
          }
```

- [ ] **Step 4: Run tests — expect them to pass**

Run: `bun test src/services/llm/model-fetcher.test.ts`
Expected: PASS — all original tests plus the four new llama.cpp cases.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/llm/model-fetcher.ts src/services/llm/model-fetcher.test.ts
git commit -m "feat(llm): fetch and enrich llama.cpp models from /v1/models + /props"
```

---

## Task 10: Route Ollama model fetching through the resolver

**Files:**
- Modify: `src/services/llm/ai-sdk-service.ts`

The fetcher already accepts a `baseUrl` argument, but `getProviderModels()` passes `modelSource.defaultBaseUrl` directly — bypassing config and env-var overrides for Ollama (and llamacpp). This step plugs in the resolver.

- [ ] **Step 1: Use resolver in `getProviderModels`**

In `src/services/llm/ai-sdk-service.ts`, locate `getProviderModels()` (around line 765). Replace:

```ts
    const providerConfig = this.config.llmConfig?.[providerName];
    const baseUrl = modelSource.defaultBaseUrl;

    if (!baseUrl) {
```

with:

```ts
    const providerConfig = this.config.llmConfig?.[providerName];
    const baseUrl =
      providerName === "ollama" || providerName === "llamacpp"
        ? resolveLocalProviderBaseUrl(providerName, this.config.llmConfig)
        : modelSource.defaultBaseUrl;

    if (!baseUrl) {
```

- [ ] **Step 2: Add a test that base-URL config is honored for llamacpp model fetch**

In `src/services/llm/ai-sdk-service.test.ts`, inside the `describe("Provider Models Configuration", …)` block (around line 563), add:

```ts
    it("uses configured base_url when fetching llamacpp models", async () => {
      let observedUrl = "";
      global.fetch = ((url: string) => {
        observedUrl = String(url);
        if (observedUrl.endsWith("/models")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: [{ id: "test-model" }] }),
          });
        }
        if (observedUrl.endsWith("/props")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                default_generation_settings: { n_ctx: 8192 },
                chat_template_caps: {},
              }),
          });
        }
        return Promise.reject(new Error("Unknown URL"));
      }) as unknown as typeof fetch;

      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("llamacpp");
        return provider.supportedModels;
      });

      const configLayer = createTestConfigLayer({
        llamacpp: { base_url: "http://example:9090/v1" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result[0]!.id).toBe("test-model");
      expect(result[0]!.contextWindow).toBe(8192);
      expect(observedUrl).toContain("example:9090");
    });
```

- [ ] **Step 3: Run tests**

Run: `bun test src/services/llm/ai-sdk-service.test.ts src/services/llm/model-fetcher.test.ts`
Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/llm/ai-sdk-service.ts src/services/llm/ai-sdk-service.test.ts
git commit -m "feat(llm): honor base_url overrides when fetching local-provider models"
```

---

## Task 11: Mark llamacpp API key as optional in agent setup

**Files:**
- Modify: `src/cli/commands/create-agent.ts:428`

- [ ] **Step 1: Update the `isOptional` condition**

Find the line:

```ts
          const isOptional = result === "ollama";
```

Replace with:

```ts
          const isOptional = result === "ollama" || result === "llamacpp";
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/create-agent.ts
git commit -m "feat(cli): make llamacpp API key optional in agent creation wizard"
```

---

## Task 12: Update integration docs

**Files:**
- Modify: `docs/integrations/index.md`

- [ ] **Step 1: Add the llama.cpp section**

In `docs/integrations/index.md`, find the section header for Ollama. Immediately after the Ollama section (before the next provider header), insert:

```markdown
### llama.cpp

**Capabilities**: Run any GGUF model locally via [`llama-server`](https://github.com/ggml-org/llama.cpp). Tool calling supported when `llama-server` is started with `--jinja` (see [function calling guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)). Context window and tool support are auto-detected from the server's `/props` endpoint.

**Setup**:

1. Build or install `llama-server` from the [llama.cpp repo](https://github.com/ggml-org/llama.cpp).
2. Start it with a model and (for tools) the `--jinja` flag:

```bash
llama-server -m /path/to/model.gguf --jinja --port 8080
```

3. Add to your config (all fields optional — defaults shown):

```json
{
  "llm": {
    "llamacpp": {
      "base_url": "http://localhost:8080/v1",
      "api_key": "your-key-if-server-uses-bearer-auth"
    }
  }
}
```

You can also set `LLAMACPP_BASE_URL` and `LLAMACPP_API_KEY` env vars; the config file takes precedence.
```

- [ ] **Step 2: Update the Ollama section to document `base_url`**

Within the Ollama section, find the JSON config example. Replace it with:

```json
{
  "llm": {
    "ollama": {
      "base_url": "http://localhost:11434/api",
      "api_key": "optional-bearer-token"
    }
  }
}
```

Then add this paragraph below the JSON block (preserve any surrounding text):

> Both fields are optional. When `base_url` is omitted, Jazz uses `http://localhost:11434/api`. You can also set `OLLAMA_BASE_URL` (config takes precedence over env).

- [ ] **Step 3: Commit**

```bash
git add docs/integrations/index.md
git commit -m "docs(integrations): add llama.cpp section and document Ollama base_url"
```

---

## Task 13: Update README provider list

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add llama.cpp to the provider listing**

Find the line in `README.md`:

```
OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Groq, Cerebras, Fireworks, TogetherAI, Ollama, OpenRouter, and more.
```

Replace with:

```
OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Groq, Cerebras, Fireworks, TogetherAI, Ollama, llama.cpp, OpenRouter, and more.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): list llama.cpp among supported providers"
```

---

## Task 14: Run the full test suite and lint

**Files:** none — verification step.

- [ ] **Step 1: Lint**

Run: `bun run lint`
Expected: clean. Fix any issues introduced by the new code (likely `import/order` since alphabetical ordering matters in this repo).

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Full test suite**

Run: `bun test`
Expected: all suites green, including the new llamacpp cases.

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: success, no type errors at the build boundary.

- [ ] **Step 5: Commit lint/format fixes if any**

If lint produced changes:

```bash
git add -p
git commit -m "chore(lint): fix lint issues in llamacpp wiring"
```

---

## Task 15: End-to-end manual verification

**Files:** none — manual verification.

This task confirms the integration works against a real `llama-server`. If you can't run `llama-server` locally, document what you verified and skip the live checks — typecheck + unit tests still cover the wiring.

- [ ] **Step 1: Start a local llama-server with --jinja**

Pre-req: `llama-server` binary plus a tool-capable GGUF (Qwen 2.5, Llama 3.1, Hermes 3, Mistral Nemo). Run:

```bash
llama-server -m /path/to/model.gguf --jinja --port 8080
```

Check the server starts and the log line `Chat format: <Hermes 2 Pro|Llama 3.x|…>` appears (not `Generic`, ideally).

- [ ] **Step 2: Verify model discovery**

In another shell:

```bash
curl -s http://localhost:8080/v1/models | jq '.data[].id'
curl -s http://localhost:8080/props | jq '{n_ctx: .default_generation_settings.n_ctx, caps: .chat_template_caps}'
```

Expected: model id and a non-empty `chat_template_caps` with `supports_tools: true`.

- [ ] **Step 3: Try the provider in Jazz**

Run: `bun run dev` (or `node dist/main.js` after build), pick **Create agent** → llama.cpp. Confirm:

- The provider appears in the picker as `llama.cpp`.
- The model picker lists the loaded model.
- The shown context window matches `/props`'s `n_ctx` (not the 128k default).

Send a quick chat that triggers a tool — e.g., "list files in this directory" — and confirm a tool call executes.

- [ ] **Step 4: Verify base-URL override**

Restart `llama-server` on port 9999 (`--port 9999`), then:

```bash
LLAMACPP_BASE_URL=http://localhost:9999/v1 bun run dev
```

Confirm Jazz reaches the new port and lists the model.

- [ ] **Step 5: Verify Ollama is not regressed**

If Ollama is installed: `bun run dev` → pick Ollama → confirm models still load and chat still works (no env vars set, no `base_url` in config). Then with `OLLAMA_BASE_URL=http://localhost:11434/api` explicitly set, repeat — same behavior.

- [ ] **Step 6: Final commit (only if any docs/notes were updated during verification)**

If verification surfaced anything to fix, fix it and commit. Otherwise, this task ends with the work merged-ready.

---

## Self-Review Checklist (post-write)

- [x] Spec coverage: every section of the spec maps to at least one task.
  - Provider registration → Tasks 1, 6, 11
  - Config types → Task 2
  - `@ai-sdk/openai-compatible` dep → Task 3
  - Resolver + defaults → Tasks 4, 5
  - selectModel wiring → Task 6
  - Always-available + auth → Task 6
  - Model fetcher /v1/models + /props → Tasks 8, 9
  - Ollama retrofit through fetcher → Task 10
  - Tests (resolver, fetcher, ai-sdk-service) → Tasks 4, 7, 8, 10
  - Docs → Tasks 12, 13
  - Verification → Tasks 14, 15

- [x] No placeholders, "TBD", or "similar to" references.
- [x] Type/name consistency: `resolveLocalProviderBaseUrl`, `transformLlamaCppModels`, `fetchLlamaCppProps`, `LlamaCppProviderConfig` are spelled identically across tasks.
- [x] Each step has either a code block, a command, or a file reference — no abstract instructions.
