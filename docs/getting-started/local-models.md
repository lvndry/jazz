---
description: "Run Jazz with self-hosted Ollama or llama.cpp, understand what offline mode disables, and enforce a real air gap at the network boundary."
---

# Run Jazz with local and air-gapped models

Jazz can run against a self-hosted inference server such as [Ollama](https://ollama.ai/) or [llama.cpp](https://github.com/ggml-org/llama.cpp). Local providers need no API key. `JAZZ_OFFLINE` disables Jazz's public catalog, marketplace, and update requests; it is a convenience switch, **not a network sandbox**. Use host or container egress controls for an enforced air gap.

## Quick setup (Ollama)

1. Install Ollama on the server and pull a tool-capable model:

   ```bash
   ollama pull qwen3
   ```

2. Set the environment for the Jazz process:

   ```bash
   export JAZZ_OFFLINE=1
   export OLLAMA_BASE_URL=http://localhost:11434
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

3. Create an agent and chat — Jazz lists models straight from Ollama's `/api/tags` endpoint, so no external catalog is needed:

   ```bash
   jazz agent create
   jazz chat
   ```

llama.cpp works the same way via `LLAMACPP_BASE_URL` (default `http://localhost:8080/v1`); start `llama-server` with `--jinja` for tool calling.

## What `JAZZ_OFFLINE` does—and does not do

With `JAZZ_OFFLINE=1` (or `true`), Jazz skips these product-service requests:

- **No update check** — the periodic npm registry version check is skipped (equivalent to `JAZZ_DISABLE_UPDATE_CHECK=1`).
- **No models.dev fetch** — the model catalog (used for cloud-provider model lists and metadata enrichment like context windows and pricing) is not fetched. Jazz uses the on-disk snapshot at `~/.jazz/cache/models-dev.json` if one exists from a previous online run, and otherwise falls back to provider-reported metadata and defaults.
- **No persona marketplace fetch** — `jazz persona browse` reads the snapshot at `~/.jazz/cache/persona-registry.json` from a previous online run, and errors if there is none. Point `JAZZ_PERSONA_REGISTRY_URL` at an internal catalog to browse and install inside the airgap.

It does **not** block inference, `web_fetch`, `http_request`, remote MCP, OTLP export, or a command the agent runs. In an air-gapped deployment, use a local provider, disable OTLP export, omit network-capable tools and MCP servers, and enforce egress at the OS, container, or firewall boundary.

## Model catalog options

Ollama and llama.cpp agents work with no catalog at all: model lists come from the local server, context windows and tool support are detected from Ollama's `/api/show` (or llama.cpp's `/props`).

If you want catalog metadata (e.g. pricing display for cloud models) inside the airgap, either:

- **Seed the snapshot**: run Jazz once with network access (or copy `~/.jazz/cache/models-dev.json` from another machine). Every successful catalog fetch refreshes this snapshot, and offline mode reads it automatically.
- **Mirror internally**: host a copy of `https://models.dev/api.json` on your network and set `JAZZ_MODELS_DEV_URL=http://mirror.internal/api.json` (leave `JAZZ_OFFLINE` unset so Jazz fetches from the mirror).

## Other network surfaces to know about

- **Web tools**: the `web_search` tool requires a configured search provider API key and will simply error without one; `web_fetch` and `http_request` reach whatever URL the agent targets — inside an airgap they can still hit internal services, which is often desirable. Network enforcement should ultimately live at the firewall.
- **MCP servers**: stdio servers run locally; HTTP servers connect to the URL you configure.
- **Telemetry**: NDJSON is always local under `~/.jazz/telemetry`; if an OTLP endpoint is configured, Jazz also exports to it. Leave OTLP unconfigured or set `telemetry.otlp.enabled` to `false` for a local-only deployment.

## Environment variable reference

| Variable                    | Effect                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `JAZZ_OFFLINE`              | `1`/`true`: skip update checks, the models.dev fetch, and the persona marketplace fetch entirely |
| `OLLAMA_BASE_URL`           | Ollama server URL (default `http://localhost:11434/api`; `/api` appended automatically)          |
| `LLAMACPP_BASE_URL`         | llama.cpp server URL (default `http://localhost:8080/v1`)                                        |
| `JAZZ_MODELS_DEV_URL`       | Internal mirror for the models.dev catalog                                                       |
| `JAZZ_PERSONA_REGISTRY_URL` | Base URL of the persona marketplace catalog (default the public Jazz site)                       |
| `JAZZ_DISABLE_UPDATE_CHECK` | `1`: skip only the update check                                                                  |
| `JAZZ_HOME`                 | Data directory (default `~/.jazz`) — holds the catalog snapshot, history, telemetry              |
