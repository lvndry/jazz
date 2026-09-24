---
description: "Configure Jazz model providers including OpenAI, Anthropic, Gemini, OpenRouter, Ollama, llama.cpp, Groq, Mistral, and ten other supported APIs."
---

# Configure model providers

An agent pins a provider and model. Changing either does not change its persona, tools, memory scopes, workflow, or deployment surface.

Run `jazz agent create` for the normal setup path. The wizard discovers configured providers, fetches their current model catalogs, and stores the selected provider and model on the agent.

## Supported providers

Where a provider is known by two names, Jazz accepts both. `GEMINI_API_KEY` is what Google's own documentation and CLI use, so it works as well as the `GOOGLE_GENERATIVE_AI_API_KEY` the AI SDK reads; set either. When both are set the canonical one wins.

The provider identifiers below come from `AVAILABLE_PROVIDERS` in [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts). Model names are not maintained in this page: hosted catalogs change frequently, so Jazz resolves them at runtime.

| Provider ID  | API-key environment variable                                      |
| ------------ | ----------------------------------------------------------------- |
| `ai_gateway` | `AI_GATEWAY_API_KEY`                                              |
| `alibaba`    | `ALIBABA_API_KEY`                                                 |
| `anthropic`  | `ANTHROPIC_API_KEY`                                               |
| `cerebras`   | `CEREBRAS_API_KEY`                                                |
| `deepseek`   | `DEEPSEEK_API_KEY`                                                |
| `fireworks`  | `FIREWORKS_API_KEY`                                               |
| `gemini`     | `GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY`               |
| `groq`       | `GROQ_API_KEY`                                                    |
| `llamacpp`   | `LLAMACPP_API_KEY` when the server requires bearer authentication |
| `minimax`    | `MINIMAX_API_KEY`                                                 |
| `mistral`    | `MISTRAL_API_KEY`                                                 |
| `moonshotai` | `MOONSHOT_API_KEY`                                                |
| `ollama`     | `OLLAMA_API_KEY` for Ollama Cloud or protected servers            |
| `openai`     | `OPENAI_API_KEY`                                                  |
| `openrouter` | `OPENROUTER_API_KEY`                                              |
| `togetherai` | `TOGETHER_AI_API_KEY`                                             |
| `xai`        | `XAI_API_KEY`                                                     |
| `yolo_auto`  | `YOLO_AUTO_API_KEY`                                               |
| `zhipuai`    | `ZHIPU_API_KEY`                                                   |

## Store credentials

Jazz resolves a provider key in this order:

1. an agent-specific `config.llmApiKeys` override;
2. the global provider configuration;
3. the provider's environment variable.

The configuration wizard writes secrets to macOS Keychain or libsecret when available. On a host without a keyring it falls back to the protected Jazz secrets file. `jazz config show` redacts resolved secrets.

For CI and containers, inject the environment variable from the platform's secret store. Do not commit provider keys in an agent JSON file merely because `llmApiKeys` exists.

## OpenRouter for model portability

OpenRouter is useful when the workflow should stay stable while the underlying hosted model changes. `openrouter/free` routes to an available free model; it is useful for experiments but not a reliability guarantee. `openrouter/auto` is also a router rather than a fixed model, so exact capabilities and pricing depend on the selected upstream model.

Create separate agents when you need a pinned production model and an experimental router. That keeps evaluation and cost attribution honest.

```bash
export OPENROUTER_API_KEY="..."
jazz agent create
```

The [CI reviewer](../guides/pr-review.md) shows the same workflow running through OpenRouter or a self-hosted model.

## Ollama

Ollama agents require no key when the server is local and unprotected. Jazz discovers models from the running server.

```bash
ollama pull qwen3-coder
ollama serve
jazz agent create
```

The default API base URL is `http://127.0.0.1:11434/api`. The first time `jazz agent create` uses Ollama, it asks for the server URL and saves it; override it later with `llm.ollama.base_url`, `OLLAMA_BASE_URL`, or the `jazz config` → **LLM Providers** wizard, which accepts a bare `host:port` and fills in the scheme and REST path; saved configuration wins over the environment.

```json
{
  "llm": {
    "ollama": {
      "base_url": "http://ollama.internal:11434/api",
      "keep_alive": "30m"
    }
  }
}
```

During agent creation Jazz asks for `numCtx`, the context window sent to Ollama as `num_ctx`. Set it to a value the model and host can actually sustain. Without it, Jazz cannot know a server-level `OLLAMA_CONTEXT_LENGTH` override and may compact later than the server truncates.

`keep_alive` controls how long Ollama keeps the model loaded. `-1` keeps it resident; an omitted value uses Ollama's default.

Models tagged `:cloud` or `-cloud` execute through Ollama Cloud and need `OLLAMA_API_KEY` or an authenticated local Ollama installation. They are not local merely because the provider ID is `ollama`.

## llama.cpp

Jazz connects to `llama-server`, vLLM, and other OpenAI-compatible servers through the `llamacpp` provider. The default base URL is `http://127.0.0.1:8080/v1`; the first time `jazz agent create` uses it, Jazz asks for the server URL and saves it. You can also set `llm.llamacpp.base_url`, `LLAMACPP_BASE_URL`, or use the `jazz config` → **LLM Providers** wizard (a bare `host:port` is enough). llama.cpp needs no API key unless the server runs with `--api-key` (vLLM's `--api-key` too); when it answers 401, `jazz agent create` asks for the key, and `jazz config` → **LLM Providers** can set it.

```bash
llama-server -m /models/model.gguf --jinja --port 8080
jazz agent create
```

Use `--jinja` when the model should call tools. Jazz reads `/props` for context and chat-template metadata when the server provides it. For reasoning models, Jazz maps the agent's reasoning effort string to llama.cpp's supported thinking controls; behavior depends on a recent server and a compatible template. vLLM only needs its normal `/v1` OpenAI-compatible endpoint; start it on the port you enter, commonly `8000`.

## Model capability overrides

Models.dev supplies broad metadata such as context length, tool support, and whether a model reasons. It does not describe every provider or local-template reasoning control. Jazz applies its own exact `provider + model` capability profiles after catalog metadata. For a private model or a self-hosted template, an operator can provide a strict local correction under `llm.capabilityOverrides`; overrides use only Jazz-defined transports and cannot inject arbitrary provider request fields.

```json
{
  "llm": {
    "capabilityOverrides": {
      "llamacpp": {
        "Qwen3-32B-Instruct": {
          "reasoning": {
            "kind": "budget",
            "transport": "llamacpp.chat.thinking-budget",
            "minimumBudgetTokens": 256,
            "maximumBudgetTokens": 32768,
            "canDisable": true
          },
          "supportsTools": true
        }
      }
    }
  }
}
```

Keys are exact server-facing model IDs. Resolution is operator override, live local-server metadata, Jazz's exact-model profile, provider default, then Models.dev. A llama.cpp budget control is never assumed from a model family: declare it only when the active template accepts it.

A bare `llama-server` serves the one model loaded at launch and ignores the requested model name, and that model can change between runs. Jazz therefore treats the model chosen at agent creation as a hint: at the start of each run it reads the actually-served model from `/v1/models` and the real context window from `/props`, so the displayed model and context accounting match what the server is running. A pinned `numCtx` still overrides the server-reported window.

## Slow first tokens from local models

Jazz abandons a provider stream that stays silent for `llm.streamIdleTimeoutMs` milliseconds, 120000 by default, and reports `Provider stream produced nothing for 120s and was abandoned`. The timer restarts on every streamed part, so it never caps a long answer, and tools run between streams rather than inside one.

A hosted provider answers well inside two minutes. Ollama or llama.cpp loading a large model from disk and then prefilling a long prompt can legitimately take longer before the first token, so raise the budget for those hosts:

```bash
jazz config set llm.streamIdleTimeoutMs 600000
```

`JAZZ_STREAM_IDLE_TIMEOUT_MS` sets the same budget for one process; the saved value wins over it. `llm.ollama.keep_alive` avoids paying the cold start again.

## Gemini naming

The Jazz provider ID is `gemini`; its SDK and environment variable retain Google's upstream naming. Existing `google` agent and configuration identifiers are migrated to `gemini` when read.

## Offline operation

`JAZZ_OFFLINE=1` disables Jazz's own update, hosted model-catalog, and library requests. It does not make a hosted provider work offline. Use Ollama or llama.cpp, preinstall every required skill dependency, and enforce the network boundary outside Jazz. Follow [Local and air-gapped models](../getting-started/local-models.md).

## Diagnose provider failures

- Authentication errors: confirm the agent's provider ID matches the key you supplied and inspect `jazz config show` for the resolved non-secret configuration.
- Stream idle errors say whether the provider produced no first part or stopped between parts. The
  former points to queuing, model loading, or prompt prefill; the latter means generation had
  already started. Local servers that legitimately need longer can set
  `llm.streamIdleTimeoutMs` or `JAZZ_STREAM_IDLE_TIMEOUT_MS`; the default is 120000 ms.
- Unknown model: rerun agent editing after the provider catalog is reachable; do not copy a model name from an old documentation page.
- Local connection errors: start the server and verify its base URL from the Jazz host, not from your laptop when Jazz runs elsewhere.
- Tool-call failures on llama.cpp: confirm the model template supports tools and the server was started with `--jinja`.
- Unexpected context truncation on Ollama: pin `numCtx` on the agent and ensure the server can allocate it.

Read [Creating agents](../getting-started/create-an-agent.md), [Local models](../getting-started/local-models.md), and [Adding a provider](../maintainers/add-a-provider.md) next.
