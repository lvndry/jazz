# Telegram bridge

Chat with a [Jazz](../../README.md) agent from Telegram, backed by your own local
models via [Ollama](https://ollama.com). A small Bun service bridges Telegram to
the `jazz` CLI: every message runs the agent once and replies with the answer —
with per-person model/persona switching, per-chat memory, and Markdown rendering.

Self-hosted, allowlist-gated, no cloud LLM required.

```
Telegram  ◀──(getUpdates long-poll)──▶  bridge  ──jazz run --json──▶  Ollama
```

## Features

- 🤖 **Any Jazz agent over Telegram** — a full tool-using agent, not an echo bot.
- 🧠 **Local models via Ollama** — no API keys, no per-token cost.
- 🎛️ **Per-person `/model` and `/persona`** — each user picks their own via inline keyboards; choices persist.
- ♻️ **Auto reasoning** — switching models reads Ollama's advertised capabilities and enables/disables thinking so non-thinking models don't error.
- 💬 **Per-chat memory**, ✍️ **Markdown rendering** (with plain-text fallback), 🔒 **allowlist-gated**, 🐳 **one-command Docker deploy**.

## Requirements

- [Ollama](https://ollama.com) running with a **tool-capable** model pulled (`ollama list`).
- Docker + Docker Compose.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Outbound HTTPS to `api.telegram.org`.

## Quick start

**1. Create a bot.** Message [@BotFather](https://t.me/BotFather), `/newbot`, pick a
name and a username ending in `bot`, copy the token. Get your numeric chat id from
[@userinfobot](https://t.me/userinfobot).

**2. Configure.** From this directory (`integrations/telegram-bot/` in the Jazz repo):

```sh
cp .env.example .env
```

Set at least `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, and
`JAZZ_TELEGRAM_MODEL` (a model from your `ollama list`).

**3. Run.** The image builds Jazz from the repo source, so the compose build
context is the repo root (already wired):

```sh
docker compose up -d --build
docker compose logs -f          # expect "Polling Telegram for updates…"
```

Message your bot: it shows a "typing…" indicator, then the agent's reply.

## Commands

| Command | What it does |
|---|---|
| _(any message)_ | Answered by your agent |
| `/model` | Inline keyboard of pulled Ollama models — pick yours |
| `/persona` | Inline keyboard of available personas |
| `/help` | Usage |

Each Telegram user gets an independent agent (`tg_<chat_id>.json`, cloned from the
`telegram` template on first contact), so `/model` and `/persona` change only *your*
experience. `JAZZ_TELEGRAM_MODEL` / `JAZZ_REASONING` set the defaults new chats
start from.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Bot token from @BotFather. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | **Required.** Comma-separated chat ids allowed to use the bot. |
| `JAZZ_TELEGRAM_MODEL` | `qwen3.6:27b` | Default Ollama model (must be pulled). |
| `JAZZ_REASONING` | `medium` | Default reasoning: `disable`\|`low`\|`medium`\|`high`. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434/api` | Ollama endpoint reachable from the container. |
| `JAZZ_APPROVAL_POLICY` | `low-risk` | Auto-approve tools up to: `read-only`\|`low-risk`\|`high-risk`. |
| `JAZZ_RUN_TIMEOUT_MS` | `300000` | Per-message agent timeout. |
| `TELEGRAM_MODE` | `polling` | `polling` or `webhook`. |
| `PORT` | `8080` | In-container health-check port. |

> **Model ↔ reasoning:** thinking-capable models (qwen3, …) work with
> `medium`/`high`; models without a thinking capability (mistral-small, gemma, …)
> error unless reasoning is `disable`. `/model` sets this automatically.

## How it works

For each allowed message the bridge runs:

```
jazz run --no-tui --json --agent tg_<chat_id> --conversation <chat_id> "<text>"
```

`--conversation` gives per-chat memory; the per-chat agent file supplies the
model/persona. Data lives in the `jazz_data` volume (`JAZZ_HOME=/data`): agents in
`/data/agents`, transcripts in `/data/history` (keyed by chat id, **plaintext
JSON** — treat the volume as sensitive), logs in `/data/logs`.

## Webhook mode

Long-polling (default) needs no public endpoint. For a webhook, expose the bridge
over HTTPS and set `TELEGRAM_MODE=webhook`, `TELEGRAM_WEBHOOK_SECRET`
(`openssl rand -hex 32`), and `TELEGRAM_WEBHOOK_URL=https://your.host/telegram/webhook`.
Add a `ports:` mapping to `docker-compose.yml` to expose the port. The bridge calls
`setWebhook` on startup and verifies Telegram's secret header.

## Security notes

- Only `TELEGRAM_ALLOWED_CHAT_IDS` are answered; everyone else is ignored.
- The agent has real tools and runs at `JAZZ_APPROVAL_POLICY` **without a human in
  the loop**. On a networked host, be deliberate about the toolset in
  `agent.telegram.json` and the approval level. The default toolset is
  read/search/write with no shell or git.
