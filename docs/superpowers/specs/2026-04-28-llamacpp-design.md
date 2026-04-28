# Design: llama.cpp provider support

**Status:** Draft
**Date:** 2026-04-28

## Context

Jazz supports many LLM providers but not [llama.cpp](https://github.com/ggml-org/llama.cpp), the most widely-deployed local-inference engine for GGUF models. Today users wanting local inference must use Ollama, which carries its own model store, daemon, and quantization conventions. Many community model releases ship as raw `.gguf` files designed for `llama-server` and never get an Ollama port. Adding llama.cpp closes that gap, gives users a path to running models that aren't on Ollama, and brings parity with other CLI agents that already integrate it.

A small adjacent improvement falls out: Jazz's Ollama integration hardcodes its base URL (`http://localhost:11434/api`). The same configurability work needed for llama.cpp lets us retrofit Ollama at near-zero extra cost.

## Goals

1. Register `llamacpp` as a first-class provider, reachable through `llama-server`'s OpenAI-compatible `/v1` API.
2. Auto-detect the loaded model's context window and tool-calling capability from `llama-server`'s `/props` endpoint.
3. Allow `base_url` overrides (config + env var) for both `llamacpp` and `ollama`.

## Non-goals

- In-process inference via `node-llama-cpp` or other native bindings.
- Native llama.cpp endpoints (`/completion`, GBNF grammars, `/slots` management).
- Tool-support config flag for Ollama (would mirror llama.cpp's auto-detection if Ollama exposed equivalent metadata; deferred).

## Architecture

`llamacpp` is registered alongside `ollama` and uses Vercel AI SDK's `@ai-sdk/openai-compatible` adapter (new dependency, installed via `bun add`). The provider slots into the existing factory in `src/services/llm/ai-sdk-service.ts:479` with no changes to streaming or tool-call plumbing — the OpenAI-compatible adapter handles those.

```
                 ┌─────────────────────────────────────────────────┐
                 │         llama-server (user-managed)             │
                 │  ┌──────────────────┐  ┌──────────────────┐     │
                 │  │ /v1/chat/...     │  │ /v1/models       │     │
                 │  │ /v1/completions  │  │ /props           │     │
                 │  └──────────────────┘  └──────────────────┘     │
                 └────────────────────▲────────────────────────────┘
                                      │
   ┌──────────────────────────────────┼──────────────────────────────┐
   │                                  │                              │
   │  selectModel("llamacpp")    transformLlamaCppModels()           │
   │     │                            │                              │
   │  createOpenAICompat({          fetch /v1/models +                │
   │   baseURL, headers })          fetch /props once                 │
   │                                                                  │
   │       ai-sdk-service.ts          model-fetcher.ts                │
   └──────────────────────────────────────────────────────────────────┘
```

## Configuration

```ts
// src/core/types/config.ts
export interface LlamaCppProviderConfig {
  readonly api_key?: string;     // optional, sent as Bearer when set
  readonly base_url?: string;    // overrides http://localhost:8080/v1
}

export interface OllamaProviderConfig {
  readonly api_key?: string;
  readonly base_url?: string;    // NEW — overrides http://localhost:11434/api
}

export interface LLMConfig {
  // …existing fields
  readonly llamacpp?: LlamaCppProviderConfig;
}
```

**Base URL resolution** (highest precedence first), unified for both local providers via a new helper in `src/services/llm/models.ts`:

```ts
export function resolveLocalProviderBaseUrl(
  provider: "llamacpp" | "ollama",
  llmConfig?: LLMConfig,
): string;
```

1. `llmConfig.<provider>.base_url`
2. Env var: `LLAMACPP_BASE_URL` / `OLLAMA_BASE_URL`
3. `PROVIDER_MODELS[<provider>].defaultBaseUrl`

Defaults preserved: `llamacpp` → `http://localhost:8080/v1`, `ollama` → `http://localhost:11434/api`. Existing Ollama configs keep working unchanged.

`PROVIDER_ENV_VARS` in `ai-sdk-service.ts:356` gains `llamacpp: "LLAMACPP_API_KEY"` for symmetric env-var fallback (key remains optional).

## Model discovery

`createModelFetcher()` (`src/services/llm/model-fetcher.ts`) gets a llama.cpp branch that mirrors the Ollama path:

1. `GET <base_url>/models` — returns the loaded model(s).
2. `GET <base_url-without-/v1>/props` — returns server-wide state. Called **once per fetch**, not per model (`llama-server` runs one model per process; even in router mode, `/props` is shared).
3. For each model entry, build a `ModelInfo`:
   - `contextWindow`: `props.default_generation_settings.n_ctx` if available, else `DEFAULT_CONTEXT_WINDOW`.
   - `supportsTools`: `props.chat_template_caps?.supports_tools === true && props.chat_template_caps?.supports_tool_calls === true`. Field is populated by llama.cpp's `jinja::caps::to_map()` (see `common/jinja/caps.h`); when `--jinja` is off or the field is missing, both checks are false → `supportsTools = false`.
   - `isReasoningModel`: `false` (no reliable signal; can be added later if `chat_template_caps` exposes one).
   - `displayName`: same as `id` (server-supplied, often the `--alias` or filename).
4. models.dev lookup is performed first as a courtesy (unlikely to hit — quantized GGUFs use arbitrary names).

**New helpers in `model-fetcher.ts`:**

```ts
type LlamaCppModelsResponse = { data: Array<{ id: string }> };
type LlamaCppPropsResponse = {
  default_generation_settings?: { n_ctx?: number };
  chat_template_caps?: Record<string, boolean>;
};

async function fetchLlamaCppProps(baseUrl: string): Promise<LlamaCppPropsResponse | undefined>;
async function transformLlamaCppModels(
  data: unknown,
  baseUrl: string,
  modelsDevMap: Map<string, ModelsDevMetadata> | null,
): Promise<ModelInfo[]>;
```

**Error handling:**
- `/props` failure → log warn, fall through to defaults (`DEFAULT_CONTEXT_WINDOW`, `supportsTools: false`).
- `/models` empty → friendly error mirroring Ollama's pattern (`model-fetcher.ts:325`): *"No models loaded. Start `llama-server` with `-m <path>.gguf` first."*
- Non-llama.cpp server on the configured port → `/v1/models` will likely succeed (OpenAI-compat is common) but `/props` will 404; we degrade to defaults rather than error.

## Wiring checklist

| File | Change |
|---|---|
| `src/core/constants/models.ts` | Add `llamacpp: []` to `STATIC_PROVIDER_MODELS`. |
| `src/core/utils/string.ts` | Add `llamacpp: "llama.cpp"` to `PROVIDER_DISPLAY_NAMES`. |
| `src/core/types/config.ts` | Add `LlamaCppProviderConfig`; extend `OllamaProviderConfig` with `base_url`; add `llamacpp?` to `LLMConfig`. |
| `src/services/llm/models.ts` | Register `llamacpp` in `PROVIDER_MODELS` (`type: "dynamic"`, `endpointPath: "/models"`, `defaultBaseUrl: "http://localhost:8080/v1"`). Add `DEFAULT_LLAMACPP_BASE_URL` constant. Add `resolveLocalProviderBaseUrl()` helper. |
| `src/services/llm/ai-sdk-service.ts` | New `case "llamacpp"` in `selectModel()` using `@ai-sdk/openai-compatible`. Update `case "ollama"` to use the resolver. Append `llamacpp` to `getConfiguredProviders()` after Ollama (always-available, no API key required). Add `llamacpp: "LLAMACPP_API_KEY"` to `PROVIDER_ENV_VARS`. |
| `src/services/llm/model-fetcher.ts` | Add llama.cpp branch: `transformLlamaCppModels()` and `fetchLlamaCppProps()`. |
| `src/cli/commands/create-agent.ts:428` | `isOptional = result === "ollama" \|\| result === "llamacpp"`. |
| `package.json` | New dep `@ai-sdk/openai-compatible` (added via `bun add`). |

## Tests

Bun-test (per project convention, no vitest).

- `src/services/llm/model-fetcher.test.ts` (extend):
  - Happy path: `/v1/models` + `/props` populated → context window from `n_ctx`, tools from `chat_template_caps`.
  - `/props` 404 → falls back to `DEFAULT_CONTEXT_WINDOW` and `supportsTools: false`, no throw.
  - Empty `/v1/models` → friendly "no models loaded" error.
  - `chat_template_caps.supports_tools=true` but `supports_tool_calls=false` → `supportsTools: false` (both required).
- `src/services/llm/ai-sdk-service.test.ts` (extend):
  - `selectModel("llamacpp", "qwen2.5", { llamacpp: { base_url: "http://example:9090/v1" } })` builds with the configured URL.
  - `getConfiguredProviders()` returns `llamacpp` even with no config (always-available).
  - `LLAMACPP_BASE_URL` env var overrides default; `llmConfig.llamacpp.base_url` overrides env var.
- `src/services/llm/base-url-resolver.test.ts` (new): covers `resolveLocalProviderBaseUrl()` precedence (config → env → default) for both `llamacpp` and `ollama`.

## Documentation

- `docs/integrations/index.md`: new section after Ollama, mirroring the OpenAI/Anthropic format. Cover `llama-server` install/run, `--jinja` for tool calls, config snippet, env vars, link to llama.cpp's [function-calling guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md).
- Update Ollama section to document the new `base_url` override and `OLLAMA_BASE_URL`.
- Update README.md provider list (`README.md:101`).

## Rollout

- Additive — no migration needed.
- Existing Ollama configs unchanged: `base_url` absent → resolver returns the historical default.
- Single new dep: `@ai-sdk/openai-compatible`.

## Verification

1. Run `llama-server -m <some.gguf> --jinja --port 8080`.
2. `bun test` passes (incl. new cases).
3. `bun run typecheck` clean.
4. `bun run dev` → create an agent → pick `llama.cpp` provider → confirm model picker lists the loaded model with the correct context window. With a tool-capable model loaded under `--jinja`, send a request that triggers a tool call and confirm it executes.
5. Set `LLAMACPP_BASE_URL=http://localhost:9999/v1` for a non-default port and confirm Jazz hits the new URL.
6. With Ollama running, set `OLLAMA_BASE_URL=http://localhost:11434/api` (no-op) and unset it; confirm both work and existing Ollama users are unaffected.
