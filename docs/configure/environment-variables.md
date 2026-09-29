---
description: "Every environment variable Jazz reads: data location, terminal display, network and catalogs, provider keys and server URLs, telemetry, installer, and the chat bots."
---

# Environment variables

Every variable Jazz reads, grouped by what it controls. A command-line flag wins over its
variable, and a setting in `config.json` wins over a variable unless the row says otherwise.
Boolean switches marked `1` accept only `1`; anything else leaves them off.

The `scripts/check-environment-variables.test.ts` test fails when the code reads a `JAZZ_*`
variable, a provider key variable or a local server URL variable that this page does not
list.

## Where Jazz keeps things

| Variable                         | Effect                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JAZZ_HOME`                      | Directory for config, agents, conversations, memory, logs and secrets. Defaults to `~/.jazz`. `--data-dir` wins.                                                                                                  |
| `JAZZ_CONFIG_PATH`               | Global config file to use instead of `$JAZZ_HOME/config.json`. `~` is expanded.                                                                                                                                   |
| `JAZZ_LOG_DIR`                   | Directory for log files. Defaults to `$JAZZ_HOME/logs`.                                                                                                                                                           |
| `JAZZ_DISABLE_KEYRING`           | Any value other than empty, `0` or `false` turns off the OS keyring and the secrets-file fallback, so Jazz stores no secrets and reads keys only from the environment. Useful for CI and for isolated test homes. |
| `JAZZ_CHATGPT_CREDENTIAL`        | Optional JSON ChatGPT OAuth bundle used only when Jazz has no stored ChatGPT credential. Jazz removes it from child-process environments after reading it.                                                        |
| `JAZZ_CHATGPT_CREDENTIAL_OUTPUT` | Optional file path where Jazz writes a rotated ChatGPT OAuth bundle after refresh. The file is created with mode `0600`; use it only to persist the refreshed credential in hosted CI.                            |

## Terminal and display

| Variable                          | Effect                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JAZZ_OUTPUT_MODE`                | `rendered`, `hybrid`, `raw` or `quiet`. Wins over `output.mode`; `--output` wins over it. Other values are ignored.                                                                                                            |
| `JAZZ_NO_TUI`                     | `1` turns off the terminal UI entirely and prints plain output. `--no-tui` sets it.                                                                                                                                            |
| `JAZZ_FULLSCREEN`                 | `0` or `false` keeps the interactive UI but draws it inline instead of on the alternate screen.                                                                                                                                |
| `JAZZ_A11Y`, `INK_SCREEN_READER`  | `1` turns off the fullscreen interface, for screen readers.                                                                                                                                                                    |
| `JAZZ_THEME`                      | `light` or `dark`. When unset, Jazz reads `COLORFGBG` and otherwise assumes dark. `/theme` in a chat shows how to set it.                                                                                                      |
| `JAZZ_UI_GLYPHS`                  | `unicode` or `ascii` symbols. Detected from the terminal when unset.                                                                                                                                                           |
| `JAZZ_TABLE_STYLE`                | `unicode`, `minimal` or `ascii` borders for Markdown tables. Follows `JAZZ_UI_GLYPHS` when unset.                                                                                                                              |
| `JAZZ_TERMINAL`                   | Overrides terminal detection, such as `iterm2`, `terminal-app`, `warp` or `xterm`. Detected from `TERM_PROGRAM` and `TERM` when unset.                                                                                         |
| `JAZZ_NOTIFICATIONS_TERMINAL`     | `auto`, `osc99`, `osc777`, `osc9` or `off`: how desktop notifications reach the terminal. Wins over `notifications.terminal`. Other values are ignored. See [Desktop notifications](./notifications.md#desktop-notifications). |
| `NO_COLOR`, `NODE_DISABLE_COLORS` | Any value turns color off.                                                                                                                                                                                                     |
| `VISUAL`, `EDITOR`                | Editor for `jazz persona edit` and `jazz mcp add`, after the `editor` setting. Falls back to `vi`.                                                                                                                             |

## Network and catalogs

| Variable                                             | Effect                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JAZZ_OFFLINE`                                       | `1` or `true` stops the requests Jazz makes on its own: the update check and the models.dev and library catalogs, which fall back to their caches. Model requests are unaffected. See [Privacy](../security/privacy.md). |
| `JAZZ_DISABLE_UPDATE_CHECK`                          | `1` skips the update check when a command starts.                                                                                                                                                                        |
| `JAZZ_MODELS_DEV_URL`                                | Replacement URL for the models.dev catalog.                                                                                                                                                                              |
| `JAZZ_LIBRARY_URL`                                   | Replacement base URL for the persona, workflow and skill library. Defaults to `https://jazz-cli.vercel.app/library`.                                                                                                     |
| `JAZZ_PLUGIN_CATALOG_URL`                            | Replacement base URL for plugin catalog ids. Defaults to `https://jazz-cli.vercel.app/library/plugins/`.                                                                                                                 |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | Route every request Jazz makes through a proxy. Lowercase forms win over uppercase; `ALL_PROXY` covers both schemes.                                                                                                     |

## Runs, scheduling and the daemon

| Variable                      | Effect                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `JAZZ_STREAM_IDLE_TIMEOUT_MS` | How long a model stream may stay silent before Jazz abandons it, in milliseconds. `llm.streamIdleTimeoutMs` wins. Defaults to 120000. |
| `JAZZ_SCHEDULER`              | `in-process` leaves scheduled work to `jazz daemon` instead of launchd or cron, like `scheduler.mode`.                                |
| `JAZZ_DAEMON_TICK_MS`         | How often the daemon checks for due work, in milliseconds. Defaults to 5000.                                                          |
| `JAZZ_DISABLE_CATCH_UP`       | `1` skips the prompt to run workflows missed while the machine was off, and the failed-runs notice.                                   |

`JAZZ_NOTIFY_<NAME>_<FIELD>` supplies a notify target secret, taking precedence over the
keyring: for example, `JAZZ_NOTIFY_PHONE_BOT_TOKEN`, `JAZZ_NOTIFY_TEAM_WEBHOOK_URL`, or
`JAZZ_NOTIFY_OPS_SECRET`. Target names and field names become uppercase with underscores.
See [Notifications](./notifications.md).

`JAZZ_SPEND_LEDGER=parent` tells a child process that its caller records its spend. The child
skips its own ledger recording and cap checks; chat bridges set this to avoid counting
a run twice. Leave it unset for standalone runs.

## Model provider keys and servers

A provider key in the environment is used when no key is saved for that provider. See
[Model providers](./providers.md#store-credentials) for the order Jazz checks.

| Provider     | Key variable                                        |
| ------------ | --------------------------------------------------- |
| `ai_gateway` | `AI_GATEWAY_API_KEY`                                |
| `alibaba`    | `ALIBABA_API_KEY`                                   |
| `anthropic`  | `ANTHROPIC_API_KEY` (and `ANTHROPIC_WORKSPACE_ID`)  |
| `cerebras`   | `CEREBRAS_API_KEY`                                  |
| `deepseek`   | `DEEPSEEK_API_KEY`                                  |
| `fireworks`  | `FIREWORKS_API_KEY`                                 |
| `gemini`     | `GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY` |
| `groq`       | `GROQ_API_KEY`                                      |
| `llamacpp`   | `LLAMACPP_API_KEY`                                  |
| `minimax`    | `MINIMAX_API_KEY`                                   |
| `mistral`    | `MISTRAL_API_KEY`                                   |
| `moonshotai` | `MOONSHOT_API_KEY`                                  |
| `nvidia`     | `NVIDIA_API_KEY`, or `NIM_API_KEY`                  |
| `ollama`     | `OLLAMA_API_KEY` (Ollama Cloud models)              |
| `openai`     | `OPENAI_API_KEY`                                    |
| `openrouter` | `OPENROUTER_API_KEY`                                |
| `orcarouter` | `ORCAROUTER_API_KEY`                                |
| `sglang`     | `SGLANG_API_KEY`                                    |
| `togetherai` | `TOGETHER_AI_API_KEY`                               |
| `vllm`       | `VLLM_API_KEY`                                      |
| `xai`        | `XAI_API_KEY`                                       |
| `zhipuai`    | `ZHIPU_API_KEY`                                     |

`chatgpt` has no key variable: sign in from **Settings** → **LLM Providers** in
the `jazz` home menu.

Self-hosted servers are found at these addresses. A saved `llm.<provider>.base_url` wins
over the variable.

| Variable            | Default                      |
| ------------------- | ---------------------------- |
| `OLLAMA_BASE_URL`   | `http://127.0.0.1:11434/api` |
| `LLAMACPP_BASE_URL` | `http://127.0.0.1:8080/v1`   |
| `VLLM_BASE_URL`     | `http://127.0.0.1:8000/v1`   |
| `SGLANG_BASE_URL`   | `http://127.0.0.1:30000/v1`  |

Web search keys: `BRAVE_API_KEY`, `EXA_API_KEY`, `LINKUP_API_KEY`, `PARALLEL_API_KEY`,
`PERPLEXITY_API_KEY` and `TAVILY_API_KEY`. See [Web search](./web-search.md).

## Daemon, peer and webhook tokens

Each is checked before the keyring.

| Variable                     | Effect                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `JAZZ_DAEMON_TOKEN`          | The daemon's bearer token.                                                                                                     |
| `JAZZ_PEER_TOKEN_<NAME>`     | The token for one peer. `<NAME>` is the peer name in upper case, with every character outside `A-Z` and `0-9` turned into `_`. |
| `JAZZ_PEER_TOKEN`            | Where `jazz peers set-token <name>` reads the token from, unless `--from-env` names another variable.                          |
| `JAZZ_WEBHOOK_TOKEN_<NAME>`  | The token for one webhook, named the same way.                                                                                 |
| `JAZZ_WEBHOOK_SECRET_<NAME>` | The signing secret for one webhook that uses `signature`, named the same way.                                                  |

## Telemetry

The standard OpenTelemetry variables configure OTLP export when `telemetry.otlp` does not:
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`,
`OTEL_EXPORTER_OTLP_HEADERS` (and the per-signal `_HEADERS` forms),
`OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`. See
[Observability](./observability.md).

## Tools and plugins

| Variable                                      | Effect                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PUPPETEER_EXECUTABLE_PATH`                   | Chrome or Chromium binary for the web page and PDF tools.                                           |
| `JAZZ_TERMINAL_NOTIFIER`, `TERMINAL_NOTIFIER` | Path to `terminal-notifier` for desktop notifications on macOS. The bundled copy is used otherwise. |
| `JAZZ_LSP_CONFIG`                             | Server list for the `lsp` plugin. Defaults to `~/.jazz/lsp.json`, whatever `JAZZ_HOME` is.          |

## Installer

`install.sh` reads two variables. Put them after the pipe, where they reach `bash`:

| Variable           | Effect                                                          |
| ------------------ | --------------------------------------------------------------- |
| `JAZZ_INSTALL_DIR` | Directory for the binary. Defaults to `~/.local/bin`.           |
| `JAZZ_VERSION`     | Release to install, such as `v0.15.44`. Defaults to the latest. |

## Chat bots

The bridges read these when they start each run. Each bridge's README has the full setup:
[Telegram](../../packages/telegram-bot/README.md),
[Discord](../../packages/discord-bot/README.md),
[iMessage on your Mac](../../packages/imessage-bot/README.md),
[iMessage through Photon](../../packages/photon-bot/README.md) and
[WhatsApp](../../packages/whatsapp-bot/README.md).

Bridge controls:

| Variable                       | Effect                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JAZZ_BOT_MAX_CONCURRENT_RUNS` | Maximum active runs across a bridge process. Positive integer; defaults to 4.                                                                                                      |
| `JAZZ_BOT_MAX_QUEUED_MESSAGES` | Maximum messages waiting behind a conversation’s active run. Positive integer; defaults to 5.                                                                                      |
| `JAZZ_BRIDGE_HEALTH_PORT`      | Optional health HTTP port for iMessage, Photon and WhatsApp. Disabled when unset. Telegram and Discord use their existing HTTP servers.                                            |
| `JAZZ_APPROVALS_HOME`          | Jazz home whose parked runs Telegram or Discord operators may approve or reject. Unset disables these chat commands. Runs as the bridge process, outside the conversation sandbox. |

Shared by every bridge:

| Variable                    | Effect                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JAZZ_APPROVAL_POLICY`      | Approval policy for each run: `read-only`, `low-risk` or `high-risk`. Defaults to `low-risk`.                                                                                             |
| `JAZZ_AUTO_APPROVE_TOOLS`   | Comma-separated tools approved without asking.                                                                                                                                            |
| `JAZZ_REASONING`            | Reasoning effort of the agent the bridge creates. Defaults to `medium`.                                                                                                                   |
| `JAZZ_RUN_TIMEOUT_MS`       | Time limit per run, in milliseconds. Defaults to 300000.                                                                                                                                  |
| `JAZZ_DAILY_COST_CAP_USD`   | Daily spend cap in US dollars. `0`, the default, means no cap.                                                                                                                            |
| `JAZZ_BIN`                  | The `jazz` binary the bridge runs.                                                                                                                                                        |
| `JAZZ_BUILTIN_PERSONAS_DIR` | Directory of built-in personas, set by the Docker images.                                                                                                                                 |
| `JAZZ_OLLAMA_KEEP_ALIVE`    | Written to `llm.ollama.keep_alive` in the bridge's config.                                                                                                                                |
| `BRAVE_API_KEY`             | Also selects Brave as the bridge's web search provider.                                                                                                                                   |
| `TZ`                        | Timezone for a chat that has not set one. Defaults to UTC.                                                                                                                                |
| `JAZZ_BOT_CHAT_ISOLATION`   | Gives each conversation its own user and home when the bridge runs as root with `setpriv` and `useradd`, as the Telegram and Discord images do. `0`, `false`, `off` or `no` turns it off. |
| `JAZZ_BOT_OPERATOR_GID`     | Group allowed to read every conversation's state. Defaults to the group owning the data directory.                                                                                        |
| `JAZZ_BOT_RUN_AS`           | Container `user:` in the Docker Compose files. Defaults to `0:0`.                                                                                                                         |
| `JAZZ_DEPLOY_BRANCH`        | Branch `auto-update.sh` follows. See [Keeping it updated](../guides/deploy-a-chat-agent.md#keeping-it-updated).                                                                           |

Each bridge creates and runs its own agent. The agent id, provider and model apply when the
bridge creates it; the provider defaults to `openai`.

| Bridge                  | Agent id (default)                 | Provider and model                              | Show reasoning (default)             |
| ----------------------- | ---------------------------------- | ----------------------------------------------- | ------------------------------------ |
| Telegram                | `JAZZ_TELEGRAM_AGENT` (`telegram`) | `JAZZ_TELEGRAM_PROVIDER`, `JAZZ_TELEGRAM_MODEL` | `JAZZ_TELEGRAM_SHOW_REASONING` (on)  |
| Discord                 | `JAZZ_DISCORD_AGENT` (`discord`)   | `JAZZ_DISCORD_PROVIDER`, `JAZZ_DISCORD_MODEL`   | `JAZZ_DISCORD_SHOW_REASONING` (on)   |
| iMessage on your Mac    | `JAZZ_IMESSAGE_AGENT` (`imessage`) | `JAZZ_IMESSAGE_PROVIDER`, `JAZZ_IMESSAGE_MODEL` | `JAZZ_IMESSAGE_SHOW_REASONING` (off) |
| iMessage through Photon | `JAZZ_PHOTON_AGENT` (`photon`)     | `JAZZ_PHOTON_PROVIDER`, `JAZZ_PHOTON_MODEL`     | `JAZZ_PHOTON_SHOW_REASONING` (on)    |
| WhatsApp                | `JAZZ_WHATSAPP_AGENT` (`whatsapp`) | `JAZZ_WHATSAPP_PROVIDER`, `JAZZ_WHATSAPP_MODEL` | `JAZZ_WHATSAPP_SHOW_REASONING` (off) |

`JAZZ_TELEGRAM_DYNAMIC_CTA` and `JAZZ_DISCORD_DYNAMIC_CTA` offer follow-up buttons under
replies; they are on by default.

Platform credentials, allowlists and addresses:

- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_MODE`,
  `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBAPP_BASE_URL`,
  `NOMINATIM_BASE_URL`, `PORT`.
- Discord: `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_CHANNEL_IDS`,
  `DISCORD_ALLOWED_GUILD_IDS`, `DISCORD_REQUIRE_MENTION`, `DISCORD_CREATE_THREADS`,
  `DISCORD_PUBLIC_BASE_URL`, `PORT`.
- iMessage on your Mac: `IMESSAGE_ALLOWED_HANDLES`, `IMESSAGE_ALLOWED_GROUP_CHAT_IDS`,
  `IMESSAGE_SELF_TRIGGER`, `IMSG_BIN`.
- iMessage through Photon: `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`,
  `PHOTON_ALLOWED_HANDLES`.
- WhatsApp: `WHATSAPP_ALLOWED_NUMBERS`, `WHATSAPP_ALLOWED_GROUPS`,
  `WHATSAPP_REQUIRE_MENTION_IN_GROUPS`, `WHATSAPP_AUTH_DIR`, `WHATSAPP_PAIR_NUMBER`.

## Set by Jazz

Jazz sets these for the processes it starts. Setting them yourself changes nothing useful.

- `JAZZ_AGENT_PROCESS` marks a process an agent's tool started, so `jazz goal` refuses
  decisions only you may make.
- `JAZZ_SURFACE` names the surface that started a run (`cli` unless a bridge started it).
- `GIT_TERMINAL_PROMPT=0`, and `GIT_PAGER=cat` unless you set your own, keep `git` from
  waiting on a password prompt or a pager inside a tool call.
