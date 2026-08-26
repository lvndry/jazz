---
description: "Configure any of Jazz's 18 supported LLM providers — Anthropic, OpenAI, Google, Mistral, Groq, Ollama, llama.cpp and more — behind one interface."
---

# LLM Providers

How to get an API key configured for the model you want to use.

Jazz supports **18 providers** behind one interface. You need at least one configured. Set
keys by running `jazz` → *Update configuration*, or by editing `~/.jazz/config.json`.

> **Where keys are stored:** environment variable first, then your OS keyring (macOS Keychain
> or libsecret), then `~/.jazz/config.json` as a fallback. Keys you set through the wizard go
> to the keyring when one is available, and existing plaintext keys are migrated there on next
> start. See [Security → Know where your API keys live](../../SECURITY.md#know-where-your-api-keys-live).

Full provider list: [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts).
For how the provider abstraction works, see
[Internals → Providers & models](../internals/providers-and-models.md).

> **Free option:** [OpenRouter](https://openrouter.ai) with the
> [`Free Models Router`](https://openrouter.ai/openrouter/free) needs no credit card.
> **Private option:** `ollama` or `llamacpp` keep everything on your machine — see
> [Airgapped & Self-Hosted](../guide/airgapped.md).

---

Jazz supports multiple LLM providers. You need at least one configured to create agents.
You can set or update your API keys in config by running `jazz` -> `update configuration`

## OpenAI

**Setup**:

**Capabilites**: Latest OpenAI models with advanced tool use

1. Get your API key from [OpenAI Platform](https://platform.openai.com/api-keys)
2. Add to your config:

```json
{
  "llm": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
```

**Supported Models:** [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts#L13-L27)

## Anthropic

**Capabilities**: Claude Sonnet, Haiku and Opus with advanced tool use

**Setup**:

1. Get your API key from [Anthropic Console](https://console.anthropic.com/)
2. Add to your config:

```json
{
  "llm": {
    "anthropic": {
      "api_key": "sk-ant-..."
    }
  }
}
```

**Supported Models:** [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts#L28-L32)

## Gemini

**Capabilities**: Gemini Pro and Flash models with multimodal support

**Setup**:

1. Get your API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Add to your config:

```json
{
  "llm": {
    "gemini": {
      "api_key": "AIza..."
    }
  }
}
```

> Previously named `google`. Existing configs and agents are rewritten to
> `gemini` automatically the first time Jazz reads them. The environment
> variable keeps its upstream name, `GOOGLE_GENERATIVE_AI_API_KEY`.

**Supported Models:** [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts#L33-L42)

## Mistral AI

**Capabilities**: Mistral models with strong reasoning

**Setup**:

1. Get your API key from [Mistral Console](https://console.mistral.ai/)
2. Add to your config:

```json
{
  "llm": {
    "mistral": {
      "api_key": "mist..."
    }
  }
}
```

**Supported Models:** [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts#L43-L49)

## xAI (Grok)

**Capabilities**: Grok models with real-time information

**Setup**:

1. Get your API key from [xAI Console](https://console.x.ai/)
2. Add to your config:

```json
{
  "llm": {
    "xai": {
      "api_key": "xai-..."
    }
  }
}
```

**Supported Models:** [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts#L50-L65)

## DeepSeek

**Capabilities**: Cost-effective models with strong reasoning

**Setup**:

1. Get your API key from [DeepSeek Platform](https://platform.deepseek.com/)
2. Add to your config:

```json
{
  "llm": {
    "deepseek": {
      "api_key": "sk-..."
    }
  }
}
```

**Supported Models:** [`packages/core/src/constants/models.ts`](../../packages/core/src/constants/models.ts#L66)

## Ollama (Local Models)

**Capabilities**: Run models locally without API keys

**Setup**:

1. Install Ollama from [ollama.ai](https://ollama.ai/)
2. Pull a model: `ollama pull llama3.2`
3. Jazz will auto-detect available models from your Ollama instance.

```json
{
  "llm": {
    "ollama": {
      "base_url": "http://localhost:11434/api",
      "api_key": "optional-bearer-token",
      "keep_alive": "30m"
    }
  }
}
```

All fields are optional for local models. When `base_url` is omitted, Jazz uses `http://localhost:11434/api`. You can also set `OLLAMA_BASE_URL` (config takes precedence over env).

### Ollama Cloud

Models tagged `:cloud` (or `*-cloud`, e.g. `kimi-k3:cloud`) run on [ollama.com](https://ollama.com), not on your machine. An API key from [ollama.com/settings/keys](https://ollama.com/settings/keys) is required. Some cloud models also need a Pro, Max, or Team plan plus extra usage — a valid key still gets a 403 in that case. Jazz sends those requests to `https://ollama.com/api` with `Authorization: Bearer`. Set the key via `jazz` → *Update configuration*, `jazz config set llm.ollama.api_key <key>`, or `OLLAMA_API_KEY`.

If you skip the Jazz key and use `ollama signin` instead, cloud models stay on the local daemon and Ollama authenticates them itself.

The create-agent wizard asks for the key after you pick a cloud model. Local models still do not need one.

**Context window**: When you create an Ollama agent, Jazz asks you to pick a context window from a list capped to the model's real maximum. Ollama otherwise caps the runtime context to a small default (~4096 tokens) and silently truncates long conversations regardless of the model's trained size. The choice is stored per agent (`numCtx`) and sent as `num_ctx` on every request; change it later with `jazz agent edit`.

It is also what Jazz compacts against, since it is the window the server will honour — the model's advertised maximum is not. An agent with no `numCtx` warns at run start: Jazz has no way to read the server's `OLLAMA_CONTEXT_LENGTH`, so it falls back to the advertised maximum and would compact too late if the server runs a smaller window.

**Keep-alive**: Set `keep_alive` (e.g. `"30m"`, or `"-1"` to keep the model resident indefinitely) to avoid model-reload latency between agent turns. When unset, Ollama's own default (5 minutes) applies.

Running on a server without internet access? See the [Airgapped & Self-Hosted guide](../guide/airgapped.md) — set `JAZZ_OFFLINE=1` to disable all outbound requests Jazz makes on its own.

## llama.cpp

**Capabilities**: Run any GGUF model locally via [`llama-server`](https://github.com/ggml-org/llama.cpp). Tool calling supported when `llama-server` is started with `--jinja` (see [function calling guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)). Context window and tool support are auto-detected from the server's `/props` endpoint.

**Reasoning**: An agent's reasoning effort is honored for reasoning models. Jazz maps it to llama.cpp's `reasoning_budget` (and `enable_thinking` for Qwen3-style templates): `disable` stops thinking (`reasoning_budget: 0`), while `low`/`medium`/`high` raise the thinking token budget. Reasoning traces are parsed from the server's `reasoning_content` field or inline `<think>` tags. This requires a recent `llama-server` with `--reasoning-budget` support.

**Diagnostics**: If `llama-server` is not running, Jazz reports how to start it (with the expected URL) instead of a raw connection error.

**Setup**:

1. Build or install `llama-server` from the [llama.cpp repo](https://github.com/ggml-org/llama.cpp).
2. Start it with a model and (for tools) the `--jinja` flag:

```bash
llama-server -m /path/to/model.gguf --jinja --port 8080
```

1. Add to your config (all fields optional — defaults shown):

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

---

---

## Related

- [Integrations index](./index.md)
- [Configuration](../reference/configuration.md) — the full config file reference
- [Web Search](./web-search.md)
