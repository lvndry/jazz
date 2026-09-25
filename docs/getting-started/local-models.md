---
description: "Run Jazz with self-hosted Ollama, llama.cpp, or vLLM; understand offline mode and network isolation."
---

# Run Jazz with local and air-gapped models

Jazz can run against a self-hosted inference server such as [Ollama](https://ollama.ai/), [llama.cpp](https://github.com/ggml-org/llama.cpp), or [vLLM](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/). Local providers need no API key unless the server requires one. `JAZZ_OFFLINE` disables Jazz's public catalog, library, and update requests; it is a convenience switch, **not a network sandbox**. Use host or container egress controls for an enforced air gap.

## Quick setup (Ollama)

1. Install Ollama on the server and pull a tool-capable model:

   ```bash
   ollama pull qwen3
   ```

2. Set the environment for the Jazz process:

   ```bash
   export JAZZ_OFFLINE=1
   export OLLAMA_BASE_URL=http://127.0.0.1:11434
   ```

   Point `OLLAMA_BASE_URL` at the machine running Ollama if it lives elsewhere on the internal network. Alternatively use the config file:

   ```json
   {
     "llm": {
       "ollama": {
         "base_url": "http://ollama.internal:11434"
       }
     }
   }
   ```

   Or set it interactively: run `jazz config` → **LLM Providers**, pick Ollama, llama.cpp, or vLLM, and enter the server address as `host:port` (or a full URL). Jazz adds the scheme and the provider's REST path for you, so `192.168.1.50:11434` is enough. This is the same `base_url` as above and takes precedence over the environment variable.

3. Create an agent and chat. Jazz lists models straight from Ollama's `/api/tags` endpoint, so no external catalog is needed:

   ```bash
   jazz agent create
   jazz chat
   ```

llama.cpp works the same way via `LLAMACPP_BASE_URL` (default `http://127.0.0.1:8080/v1`), or the first-use server-URL prompt in `jazz agent create`; start `llama-server` with `--jinja` for tool calling.

For vLLM, choose the `vllm` provider. It defaults to `http://127.0.0.1:8000/v1`, accepts `VLLM_BASE_URL`, and reads the IDs available at `/v1/models`. Jazz selects a sole ID automatically, or asks you to choose among several. On each run it keeps the saved ID if still served, and otherwise uses the first live ID and its context window. Use a chat-capable model and configure tool calling on the server if the agent uses tools; the model list does not reveal whether the server's tool parser is enabled. See [vLLM setup](../configure/providers.md#vllm).

A bare `llama-server` serves whatever single model was loaded at launch and ignores the model name in each request, and that model can differ between runs. So the model chosen when the agent was created is only a hint: at the start of every run Jazz asks the server (`/v1/models`) which model it is actually serving and uses that name, along with the real context window the server was started with (`/props`, i.e. `-c`). vLLM uses the same refresh pattern and reports its served context through `/v1/models` when available. Pinning `numCtx` on an agent limits Jazz's context accounting; it does not reconfigure the vLLM server.

## What `JAZZ_OFFLINE` does, and does not do

With `JAZZ_OFFLINE=1` (or `true`), Jazz skips these product-service requests:

- **No update check**: the periodic npm registry version check is skipped (equivalent to `JAZZ_DISABLE_UPDATE_CHECK=1`).
- **No models.dev fetch**: the model catalog (used for cloud-provider model lists and metadata enrichment like context windows and pricing) is not fetched. Jazz uses the on-disk snapshot at `~/.jazz/cache/models-dev.json` if one exists from a previous online run, and otherwise falls back to provider-reported metadata and defaults.
- **No library fetch**: `jazz persona browse` and `jazz workflow browse` read the snapshots at `~/.jazz/cache/persona-registry.json` and `~/.jazz/cache/workflow-registry.json` from a previous online run, and error if there is none. Point `JAZZ_LIBRARY_URL` at an internal library to browse and install inside the airgap.

It does **not** block inference, `web_fetch`, `http_request`, remote MCP, OTLP export, or a command the agent runs. In an air-gapped deployment, use a local provider, disable OTLP export, omit network-capable tools and MCP servers, and enforce egress at the OS, container, or firewall boundary.

## Model catalog options

Ollama, llama.cpp, and vLLM agents work with no catalog at all: model lists come from the local server. Ollama's `/api/show` and llama.cpp's `/props` provide additional capability and context metadata; vLLM's `/v1/models` provides model IDs and context information when the server reports it. For an uncatalogued vLLM model, Jazz allows tool configuration, but that does not confirm the server is set up to execute tool calls.

If you want catalog metadata (e.g. pricing display for cloud models) inside the airgap, either:

- **Seed the snapshot**: run Jazz once with network access (or copy `~/.jazz/cache/models-dev.json` from another machine). Every successful catalog fetch refreshes this snapshot, and offline mode reads it automatically.
- **Mirror internally**: host a copy of `https://models.dev/api.json` on your network and set `JAZZ_MODELS_DEV_URL=http://mirror.internal/api.json` (leave `JAZZ_OFFLINE` unset so Jazz fetches from the mirror).

## Other network surfaces to know about

- **Web tools**: the `web_search` tool requires a configured search provider API key and will simply error without one; `web_fetch` and `http_request` reach whatever URL the agent targets: inside an airgap they can still hit internal services, which is often desirable. Network enforcement should ultimately live at the firewall.
- **MCP servers**: stdio servers run locally; HTTP servers connect to the URL you configure.
- **Telemetry**: NDJSON is always local under `~/.jazz/telemetry`; if an OTLP endpoint is configured, Jazz also exports to it. Leave OTLP unconfigured or set `telemetry.otlp.enabled` to `false` for a local-only deployment.

## Environment variable reference

| Variable                    | Effect                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `JAZZ_OFFLINE`              | `1`/`true`: skip update checks, the models.dev fetch, and the library fetch entirely    |
| `OLLAMA_BASE_URL`           | Ollama server URL (default `http://127.0.0.1:11434/api`; `/api` appended automatically) |
| `LLAMACPP_BASE_URL`         | llama.cpp server URL (default `http://127.0.0.1:8080/v1`)                               |
| `VLLM_BASE_URL`             | vLLM server URL (default `http://127.0.0.1:8000/v1`)                                    |
| `JAZZ_MODELS_DEV_URL`       | Internal mirror for the models.dev catalog                                              |
| `JAZZ_LIBRARY_URL`          | Base URL of the persona and workflow library (default the public Jazz site)             |
| `JAZZ_DISABLE_UPDATE_CHECK` | `1`: skip only the update check                                                         |
| `JAZZ_HOME`                 | Data directory (default `~/.jazz`): holds the catalog snapshot, history, telemetry      |
