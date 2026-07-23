# Telegram bridge

Chat with a [Jazz](../../README.md) agent from Telegram. A small Bun service
bridges Telegram to the `jazz` CLI: every message runs the agent once and replies
with the answer — with per-person model/persona switching, per-chat memory, and
Markdown rendering.

Works with any Jazz provider. **Defaults to OpenAI `gpt-5.4`**; point it at a
local [Ollama](https://ollama.com) instead for fully self-hosted, no-cloud use.

```
Telegram  ◀──(getUpdates long-poll)──▶  bridge  ──jazz run --json──▶  OpenAI / Ollama / …
```

## Features

- 🤖 **Any Jazz agent over Telegram** — a full tool-using agent, not an echo bot.
- 🔌 **Bring your own model** — OpenAI `gpt-5.4` out of the box, or any provider Jazz supports (including local Ollama, no keys/cost).
- 🎛️ **Per-person `/model` and `/persona`** — each user picks their own via inline keyboards; choices persist.
- ♻️ **Auto reasoning** — switching to an Ollama model reads its advertised capabilities and enables/disables thinking so non-thinking models don't error.
- 📡 **Live progress** — a status bubble updates in real time with the agent's thinking, tool calls, sub-agents (🤖), and tools awaiting approval (⛔); it closes with a `✅ Done · tools · tokens · $cost` summary, and the answer lands as a new message (so it notifies).
- 💬 **Per-chat memory**, ✍️ **Markdown rendering** (with plain-text fallback), 🔒 **allowlist-gated**, 🐳 **one-command Docker deploy**.

## Requirements

- Docker + Docker Compose.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A model backend — **either** an API key for a cloud provider (OpenAI by default)
  **or** a local [Ollama](https://ollama.com) with a tool-capable model pulled.
- Outbound HTTPS to `api.telegram.org`.

## Quick start

**1. Create a bot.** Message [@BotFather](https://t.me/BotFather), `/newbot`, pick a
name and a username ending in `bot`, copy the token. Get your numeric chat id from
[@userinfobot](https://t.me/userinfobot).

**2. Configure.** From this directory (`integrations/telegram-bot/` in the Jazz repo):

```sh
cp .env.example .env
```

Set at least `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, and your model
backend — by default `OPENAI_API_KEY` (uses `gpt-5.4`). To go local instead, set
`JAZZ_TELEGRAM_PROVIDER=ollama` + `JAZZ_TELEGRAM_MODEL=<pulled model>`.

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
| `/model` | Inline keyboard of models pulled in Ollama — pick one (switches you to that local model) |
| `/persona` | Inline keyboard of available personas |
| `/new` (`/reset`) | Start a fresh conversation — clears earlier context; keeps your model/persona |
| `/remind <when> <text>` | Schedule a reminder DM. `<when>` = `30m`, `1h30m`, `90s`, `2d`, `18:00`, or `tomorrow 09:00` |
| `/reminders` | List your pending reminders; tap one to cancel |
| `/status` | Current model, today's runs/tokens/cost, daily cap, uptime |
| `/help` | Usage |

While a message is processing, the progress bubble carries a **⏹ Cancel** button
that kills the run. Each answer gets **contextual follow-up buttons** — a quick
second generation proposes next steps specific to the exchange (e.g. after "where's
the nearest pharmacy" → "🧭 Directions", "🕒 Opening hours", "🔍 Go deeper"); tapping
one sends it as your next message. Answers appear instantly with static
`🔍 Go deeper` / `✂️ Shorter` buttons that upgrade to the contextual set a beat
later; set `JAZZ_TELEGRAM_DYNAMIC_CTA=0` to keep only the static ones.
Set `JAZZ_DAILY_COST_CAP_USD` to cap total spend per day (0 = no cap).

**Location.** Share a location (📎 → Location) and the bot reverse-geocodes it
(OpenStreetMap Nominatim) and hands the agent the coordinates + address, so you
can ask "where am I", "nearest pharmacy", or "directions to …". The coordinates
are stored in the conversation history (plaintext) and sent to the geocoder — set
`NOMINATIM_BASE_URL=""` to disable reverse-geocoding (coords still passed to the
agent), or point it at a self-hosted Nominatim.

Reminders are persisted in `tg-reminders.json` and delivered by a sweep, so they
survive restarts (a reminder due while the bridge was down fires on next start,
marked `(delayed)`). Clock times (`18:00`, `tomorrow 09:00`) use the container's
timezone — set `TZ` in `.env` to your own; relative durations are unambiguous.

Each Telegram user gets an independent agent (`tg_<chat_id>.json`, cloned from the
`telegram` template on first contact), so `/model` and `/persona` change only *your*
experience. `JAZZ_TELEGRAM_PROVIDER` / `JAZZ_TELEGRAM_MODEL` / `JAZZ_REASONING` set
the defaults new chats start from. (`/model` lists Ollama models — handy when you
run Ollama; cloud users typically just keep the default.)

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Bot token from @BotFather. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | **Required.** Comma-separated chat ids allowed to use the bot. |
| `JAZZ_TELEGRAM_PROVIDER` | `openai` | LLM provider — `openai`, `openrouter`, `anthropic`, `groq`, `mistral`, `deepseek`, `xai`, `ollama`, … |
| `JAZZ_TELEGRAM_MODEL` | `gpt-5.4` | Default model id for the provider. |
| `OPENAI_API_KEY` (or provider's key) | — | API key for the chosen provider (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …). Not needed for `ollama`. |
| `BRAVE_API_KEY` | — | If set, `web_search` uses Brave (configured as the provider in `config.json`). |
| `JAZZ_REASONING` | `medium` | `disable`\|`low`\|`medium`\|`high`. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434/api` | Ollama endpoint (only for `provider=ollama` / `/model`). |
| `JAZZ_APPROVAL_POLICY` | `low-risk` | Auto-approve tools up to: `read-only`\|`low-risk`\|`high-risk`. |
| `JAZZ_RUN_TIMEOUT_MS` | `300000` | Per-message agent timeout. |
| `TELEGRAM_MODE` | `polling` | `polling` or `webhook`. |
| `PORT` | `8080` | In-container health-check port. |

> **Model ↔ reasoning:** reasoning-capable models (`gpt-5.4`, qwen3, …) work with
> `medium`/`high`; models without it (mistral-small, gemma, …) error unless
> reasoning is `disable`. `/model` sets this automatically for Ollama models.

## How it works

For each allowed message the bridge runs:

```
jazz run --no-tui --json --agent tg_<chat_id> --conversation <chat_id> "<text>"
```

`--conversation` gives per-chat memory; the per-chat agent file supplies the
provider/model/persona. Data lives in the `jazz_data` volume (`JAZZ_HOME=/data`):
agents in `/data/agents`, transcripts in `/data/history` (keyed by chat id,
**plaintext JSON** — treat the volume as sensitive), logs in `/data/logs`.

## Webhook mode

Long-polling (default) needs no public endpoint. For a webhook, expose the bridge
over HTTPS and set `TELEGRAM_MODE=webhook`, `TELEGRAM_WEBHOOK_SECRET`
(`openssl rand -hex 32`), and `TELEGRAM_WEBHOOK_URL=https://your.host/telegram/webhook`.
Add a `ports:` mapping to `docker-compose.yml` to expose the port. The bridge calls
`setWebhook` on startup and verifies Telegram's secret header.

## Updating Jazz

The image builds Jazz **from this repo's source** at `docker compose up --build`
time, so the deployed version is pinned to the checkout's commit — it does **not**
update on its own. To update manually:

```sh
cd <repo> && git pull origin main
cd integrations/telegram-bot && docker compose -p jazz-telegram up -d --build
```

**Nightly auto-update:** `auto-update.sh` fast-forwards to the latest `origin/main`,
rebuilds only if it changed, and rolls back if the new build isn't healthy.
Install it (as the deploy user):

```sh
(crontab -l 2>/dev/null; echo "30 4 * * * $HOME/jazz/integrations/telegram-bot/auto-update.sh >> $HOME/jazz-autoupdate.log 2>&1") | crontab -
```

It tracks `main` (bleeding edge); the health-gated rollback guards against a bad
commit. Check `~/jazz-autoupdate.log` for the run history.

## Security notes

- Only `TELEGRAM_ALLOWED_CHAT_IDS` are answered; everyone else is ignored.
- The agent ships with the **full toolset** — filesystem (incl. write/delete),
  `execute_command`, git (incl. push), HTTP, and web search — and runs
  **without a human in the loop**. `JAZZ_APPROVAL_POLICY` is the gate: at the
  default `low-risk`, higher-risk actions (shell, delete, push, …) are
  auto-declined; raise it to `high-risk` only if you understand that a prompt
  (or prompt injection) could then run arbitrary commands on the host. Trim the
  toolset in `agent.telegram.json` if you want a smaller blast radius.
