# Model Fetcher: models.dev as Single Source of Metadata

## Plan (implemented)

Rework the model fetcher so that **models.dev** is the single source of metadata (context window, tool support, reasoning) for **all providers** (both static and dynamic). Provider APIs only supply the list of model ids and display names; optional fallbacks apply only when a model is not in models.dev.

## Architecture

1. **Fetch models.dev once** (lazy load on first use) and reuse the parsed map (cache TTL 1h in `models-dev-client.ts`).
   - The JSON is ~1MB; fetched once per hour max (or once per session).
   - Parsed into an indexed `Map<modelId, metadata>` for O(1) lookups.
   - Per-provider `ModelInfo[]` is also cached in `ai-sdk-service` so we don't re-resolve after first load.

2. **List extractors** per provider (dynamic): each provider's code only turns the provider API response into `RawModelEntry[]`:
   - `id`, `displayName`, and optional `fallback` (used only when the model is not in models.dev).

3. **Shared resolve step** `resolveToModelInfo(entry, devMap)`:
   - If the model is in models.dev → use its metadata (context, tool_call, reasoning).
   - Else use `entry.fallback` or defaults (128k context, no tools, no reasoning).

4. **Static providers** (openai, anthropic, google, mistral, xai, deepseek):
   - `STATIC_PROVIDER_MODELS` only contains `{ id, displayName }` per model.
   - When `getProviderModels()` is called, it fetches models.dev and resolves metadata for each ID.
   - **To add a new model**: just add `{ id: "...", displayName: "..." }`. Metadata comes from models.dev automatically.

5. **Ollama** keeps an async fallback path for models not in models.dev:
   - Context from `/api/show`, tool support from manifest metadata.

## What changed

- **Before**: Each provider had a transformer that built full `ModelInfo` from the API; then a separate loop enriched with models.dev when present. Static providers had hardcoded metadata in `STATIC_PROVIDER_MODELS`.
- **After**: Each dynamic provider has a list extractor that returns `RawModelEntry[]`; a single `resolveToModelInfo` uses models.dev first, then fallback, then defaults. Static providers have minimal entries (id + displayName) and resolve metadata from models.dev at runtime. No per-provider metadata heuristics; models.dev is the source of truth when the model is in the API.

## What stayed

- Provider-specific HTTP calls and response parsing (OpenRouter, Groq, Ollama, ai_gateway).
- Ollama `/api/show` for context when not in models.dev.
- Ollama manifest metadata for tool support when not in models.dev.
- OpenRouter `context_length` and `supported_parameters` as fallback when not in models.dev.

## Possible follow-ups

- **models.dev as a "discovery" source**: Expose a way to list or search models across all providers via models.dev (e.g. for CLI or UI).
