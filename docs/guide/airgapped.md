# Airgapped & Self-Hosted Deployments

Jazz runs fully offline on a self-hosted server when paired with a local inference server such as [Ollama](https://ollama.ai/) or [llama.cpp](https://github.com/ggml-org/llama.cpp). Local providers need no API key, telemetry is written to local disk only, and offline mode turns off every outbound request Jazz would otherwise make on its own.

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

## What `JAZZ_OFFLINE` does

With `JAZZ_OFFLINE=1` (or `true`), Jazz never initiates network requests on its own:

- **No update check** — the periodic npm registry version check is skipped (equivalent to `JAZZ_DISABLE_UPDATE_CHECK=1`).
- **No models.dev fetch** — the model catalog (used for cloud-provider model lists and metadata enrichment like context windows and pricing) is not fetched. Jazz uses the on-disk snapshot at `~/.jazz/cache/models-dev.json` if one exists from a previous online run, and otherwise falls back to provider-reported metadata and defaults.

Inference traffic still goes to whatever provider each agent is configured with — in an airgapped deployment that should be a local provider (`ollama` or `llamacpp`).

## Model catalog options

Ollama and llama.cpp agents work with no catalog at all: model lists come from the local server, context windows and tool support are detected from Ollama's `/api/show` (or llama.cpp's `/props`).

If you want catalog metadata (e.g. pricing display for cloud models) inside the airgap, either:

- **Seed the snapshot**: run Jazz once with network access (or copy `~/.jazz/cache/models-dev.json` from another machine). Every successful catalog fetch refreshes this snapshot, and offline mode reads it automatically.
- **Mirror internally**: host a copy of `https://models.dev/api.json` on your network and set `JAZZ_MODELS_DEV_URL=http://mirror.internal/api.json` (leave `JAZZ_OFFLINE` unset so Jazz fetches from the mirror).

## Other network surfaces to know about

- **Web tools**: the `web_search` tool requires a configured search provider API key and will simply error without one; `web_fetch` and `http_request` reach whatever URL the agent targets — inside an airgap they can still hit internal services, which is often desirable. Network enforcement should ultimately live at the firewall.
- **MCP servers**: stdio servers run locally; HTTP servers connect to the URL you configure.
- **Telemetry**: local JSON files under `~/.jazz/telemetry` — never sent anywhere.

## Environment variable reference

| Variable | Effect |
| --- | --- |
| `JAZZ_OFFLINE` | `1`/`true`: skip update checks and the models.dev fetch entirely |
| `OLLAMA_BASE_URL` | Ollama server URL (default `http://localhost:11434/api`; `/api` appended automatically) |
| `LLAMACPP_BASE_URL` | llama.cpp server URL (default `http://localhost:8080/v1`) |
| `JAZZ_MODELS_DEV_URL` | Internal mirror for the models.dev catalog |
| `JAZZ_DISABLE_UPDATE_CHECK` | `1`: skip only the update check |
| `JAZZ_HOME` | Data directory (default `~/.jazz`) — holds the catalog snapshot, history, telemetry |
