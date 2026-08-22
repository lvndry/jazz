# Telegram bridge

Chat with a [Jazz](../../README.md) agent from Telegram. A small Bun service
bridges Telegram to the `jazz` CLI: every message runs the agent once and replies
with the answer — with per-person model/persona switching, per-chat memory, and
Markdown rendering.

Works with any Jazz provider. **Defaults to OpenAI `gpt-5.4`**; point it at a
local [Ollama](https://ollama.com) instead for fully self-hosted, no-cloud use.

```text
Telegram  ◀──(getUpdates long-poll)──▶  bridge  ──jazz run --json──▶  OpenAI / Ollama / …
```

## Features

- 🤖 **Any Jazz agent over Telegram** — a full tool-using agent, not an echo bot.
- 🔌 **Bring your own model** — OpenAI `gpt-5.4` out of the box, or any provider Jazz supports (including local Ollama, no keys/cost).
- 🎛️ **Per-person `/model` and `/persona`** — each user picks their own via inline keyboards; choices persist.
- ♻️ **Auto reasoning** — switching to an Ollama model reads its advertised capabilities and enables/disables thinking so non-thinking models don't error.
- 📡 **Live progress** — a status bubble updates in real time with the agent's thinking, tool calls, sub-agents (🤖), and tools awaiting approval (⛔); it closes with a `✅ Done · tools · tokens · $cost` summary, and the answer lands as a new message (so it notifies).
- ⏰ **Reminders** — `/remind 30m …` or plain language ("remind me in 2 hours …"), scheduled by the agent itself via a native tool, resolved in your own timezone (`/tz`, or auto-set from a shared location) and delivered even across restarts.
- 📍 **Location aware** — share a pin to get oriented, find nearby places, and set your timezone automatically.
- 📊 **On-demand UI** — the agent can write a self-contained webpage (a chart, a form, a small interactive tool) via `create_web_app` and deliver it as either a chat image (no tap) or a tappable Telegram Web App button.
- 🎙️ **Send voice notes, photos and files** — a voice message is listened to and acted on; a photo or PDF is read. Needs a model with that input modality (Gemini for audio, most models for images), and the bot says so plainly when the current model can't.
- 💬 **Per-chat memory**, ✍️ **Markdown rendering** (with plain-text fallback), 🔒 **allowlist-gated**, 🐳 **one-command Docker deploy**.

## Requirements

- Docker + Docker Compose.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A model backend — **either** an API key for a cloud provider (OpenAI by default)
  **or** a local [Ollama](https://ollama.com) with a tool-capable model pulled.
- Outbound HTTPS to `api.telegram.org`.
- For voice notes: a model that accepts audio input. In practice that means the
  Gemini family — Anthropic has no audio models and OpenAI has one. Images and
  PDFs work on almost anything. The image installs `ffmpeg` so Jazz can measure
  how long a clip is and budget context for it accurately.

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

| Command                 | What it does                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(any message)_         | Answered by your agent                                                                                                                                                                             |
| `/model`                | Inline keyboard of models pulled in Ollama — pick one (switches you to that local model)                                                                                                           |
| `/persona`              | Inline keyboard of available personas                                                                                                                                                              |
| `/new` (`/reset`)       | Start a fresh conversation — clears earlier context; keeps your model/persona                                                                                                                      |
| `/remind <when> <text>` | Schedule a reminder DM. `<when>` = `30m`, `1h30m`, `90s`, `2d`, `18:00`, or `tomorrow 09:00`. Routed through a normal agent turn, which calls the `add_reminder` tool.                             |
| _(natural language)_    | Just say it — "remind me to call the dentist in 2 hours". The agent calls `add_reminder` itself; it understands the same `<when>` formats as `/remind` (durations, clock times, `tomorrow HH:MM`). |
| `/reminders`            | List your pending reminders (in your timezone); tap one to cancel                                                                                                                                  |
| `/tz [zone]`            | Show or set your timezone (IANA name, e.g. `/tz Europe/Paris`) so reminder times are local                                                                                                         |
| `/status`               | Current model, your timezone, today's runs/tokens/cost, daily cap, uptime                                                                                                                          |
| `/help`                 | Usage                                                                                                                                                                                              |

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
can ask "where am I", "nearest pharmacy", or "directions to …". It also sets your
timezone from the coordinates (offline, via `tz-lookup`) so reminders land at the
right local time. The coordinates are stored in the conversation history
(plaintext) and sent to the geocoder — set `NOMINATIM_BASE_URL=""` to disable
reverse-geocoding (coords still passed to the agent), or point it at a self-hosted
Nominatim.

**Timezone.** Reminder times are resolved per person: an explicit `/tz` choice, a
zone auto-detected from a shared location, the container's `TZ`, then UTC (in that
order). Each `jazz run` is invoked with `--timezone <zone>`, so `18:00` means 6pm
where the sender is, across DST. Each chat's zone is stored in `tg-tz.json`.

Reminders are stored per Telegram chat's agent, one JSON file per agent under
`reminders/` in the Jazz home directory (`reminders/tg_<chat_id>.json`), written by
the `add_reminder`/`cancel_reminder` tools rather than the bridge itself. A sweep
delivers due reminders every 20s, so they survive restarts (one due while the
bridge was down fires on next start, marked `(delayed)`). Relative durations
(`30m`, `2h`) are timezone-independent.

Each Telegram user gets an independent agent (`tg_<chat_id>.json`, cloned from the
`telegram` template on first contact), so `/model` and `/persona` change only _your_
experience. `JAZZ_TELEGRAM_PROVIDER` / `JAZZ_TELEGRAM_MODEL` / `JAZZ_REASONING` set
the defaults new chats start from. (`/model` lists Ollama models — handy when you
run Ollama; cloud users typically just keep the default.)

**Mail & calendar.** The image ships [Himalaya](https://github.com/pimalaya/himalaya)
(email), [khal](https://github.com/pimutils/khal) + [vdirsyncer](https://github.com/pimutils/vdirsyncer)
(calendar, non-Google), and [gcalcli](https://github.com/insanum/gcalcli) (calendar,
Google) — the CLIs the `email`/`calendar` skills already know how to drive via
`execute_command` (see [Email & Calendar](../../docs/integrations/email-calendar.md)
and the calendar skill's [Google Calendar (gcalcli)](../../skills/calendar/SKILL.md#google-calendar-gcalcli)
section). None of them are allowlisted: like every other shell command, each call is
`high-risk` and shows up in Telegram as an Accept/Reject prompt before it runs.

Their config/data/keyring/password-store live under `/data` (the same volume
Jazz already persists) via `XDG_CONFIG_HOME`/`XDG_DATA_HOME`, so setup survives
restarts and rebuilds. **Account credentials still have to go in yourself** —
these tools' setup wizards need a real terminal and neither the bot nor the
skills will accept a password typed into Telegram chat. None of this is
trivial, especially Google Calendar — follow it closely.

```sh
docker compose exec jazz-telegram sh
```

*Email (any provider, via Himalaya):*

```sh
himalaya   # interactive account wizard — IMAP/SMTP, or a Gmail app password
```
For Gmail specifically, generate an [app password](https://myaccount.google.com/apppasswords)
first (needs 2-Step Verification on). **Repeat this step for every account**:
running bare `himalaya` again — with a config already present — offers to add
another named account rather than reconfiguring the existing one; target a
specific one afterward with `himalaya --account account-a ...` /
`himalaya --account account-b ...`.

*Calendar, non-Google (iCloud, Nextcloud, Fastmail, any real CalDAV server), via khal/vdirsyncer:*

```sh
gpg --full-generate-key   # one-time only, for `pass` — khal/vdirsyncer store
                          # CalDAV passwords via pass, not plaintext config
pass init <your-gpg-id>   # also one-time; one key covers every account below
```

The rest is per account — namespace the `pass` entry and give each account
its own `vdirsyncer` pair/storage block (see the calendar skill's advanced
CalDAV setup) so a second account doesn't overwrite the first's credentials
or sync target:

```sh
pass insert <provider>/account-a/app-password
pass insert <provider>/account-b/app-password
vdirsyncer discover && vdirsyncer sync   # syncs every configured pair/account at once
khal configure                           # or hand-write ~/.config/khal/config, one calendar block per account
```

*Calendar, Google, via gcalcli:* **do not use khal/vdirsyncer for Google Calendar
— it doesn't work.** Google's CalDAV endpoint rejects the standard discovery
handshake khal/vdirsyncer need (confirmed: `403 Given URL is not a homeset URL`,
even with a valid OAuth token), on top of no longer accepting app-password auth
at all. gcalcli talks to the real Calendar REST API instead.

Step 1 below is one-time, shared by every Google account. **Steps 2-4 are
per-account** — the full walkthrough here authorizes two accounts,
`account-a` and `account-b`, side by side so it's obvious how to add a
third or fourth: pick a new account name/email and a new
`$XDG_DATA_HOME` directory, then redo steps 2-4 unchanged otherwise.

1. [Google Cloud Console](https://console.cloud.google.com) → new/existing
   project → enable **Google Calendar API** → **OAuth consent screen**
   (External, add every Gmail address that will use this as a test user) →
   **Credentials → Create Credentials → OAuth client ID**, type **Desktop app**.
   This gives one `client_id`/`client_secret` shared across every account below.
2. Authorize with an isolated data directory per account — gcalcli's cache
   path is keyed off `$XDG_DATA_HOME`, not `--config-folder`, so skipping
   this means the second account's login silently overwrites the first's:
   ```sh
   XDG_DATA_HOME=/data/xdg-data/gcalcli-account-a gcalcli --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" init
   XDG_DATA_HOME=/data/xdg-data/gcalcli-account-b gcalcli --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" init
   ```
   Run these one at a time, completing steps 3-4 for `account-a` before
   starting `account-b` — don't kick off both `init`s together.
3. **If `init` hangs after you click Allow in the browser, this is a known
   issue, not a misconfiguration** — its local callback server can grab the
   wrong one of two connections a browser opens and block forever. Kill it and
   recover manually instead of retrying: build the authorization URL yourself
   for the account you're currently on
   (`https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=CLIENT_ID&redirect_uri=http://localhost:8080&scope=https://www.googleapis.com/auth/calendar&access_type=offline&prompt=select_account%20consent&login_hint=ACCOUNT_EMAIL`
   — the `redirect_uri` never needs to actually respond, and `login_hint` must
   be that specific account's address), click Allow, copy the failed
   `http://localhost:8080/?...&code=...` URL from the address bar, then
   exchange the code directly:
   ```sh
   curl -s -X POST https://oauth2.googleapis.com/token \
     -d "code=$CODE" -d "client_id=$CLIENT_ID" -d "client_secret=$CLIENT_SECRET" \
     -d "redirect_uri=http://localhost:8080" -d "grant_type=authorization_code"
   ```
   and write the JSON response into **that account's**
   `$XDG_DATA_HOME/gcalcli/oauth` (e.g. `.../gcalcli-account-a/gcalcli/oauth`)
   with keys `access_token`, `client_id`, `client_secret`, `refresh_token`,
   `token_uri` (`https://oauth2.googleapis.com/token`), `scopes` (a list) —
   gcalcli accepts this legacy JSON shape and converts it to its normal cache
   on next use.

   **`prompt=select_account consent` and a per-account `login_hint` are not
   optional once a second account is involved.** Omit them and Google
   silently reuses whichever account is already logged into the browser, so
   `account-b`'s token ends up authenticating as `account-a` — this happened
   during initial setup and was only caught by checking step 4 below.
4. Verify **before moving on to the next account**:
   ```sh
   XDG_DATA_HOME=/data/xdg-data/gcalcli-account-a gcalcli list
   XDG_DATA_HOME=/data/xdg-data/gcalcli-account-b gcalcli list
   ```
   Each must show that account's own calendars. If two accounts show the
   same calendars, redo the one that's wrong with the `login_hint`/`prompt`
   params from step 3.

Full walkthrough, including the connection-race recovery in more detail, is in the calendar skill.

## Configuration

| Variable                             | Default                                 | Purpose                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                 | —                                       | **Required.** Bot token from @BotFather.                                                                                                                                                                                                                    |
| `TELEGRAM_ALLOWED_CHAT_IDS`          | —                                       | **Required.** Comma-separated chat ids allowed to use the bot.                                                                                                                                                                                              |
| `JAZZ_TELEGRAM_PROVIDER`             | `openai`                                | LLM provider — `openai`, `openrouter`, `anthropic`, `groq`, `mistral`, `deepseek`, `xai`, `ollama`, …                                                                                                                                                       |
| `JAZZ_TELEGRAM_MODEL`                | `gpt-5.4`                               | Default model id for the provider.                                                                                                                                                                                                                          |
| `OPENAI_API_KEY` (or provider's key) | —                                       | API key for the chosen provider (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …). Not needed for `ollama`.                                                                                                                                                    |
| `BRAVE_API_KEY`                      | —                                       | If set, `web_search` uses Brave (configured as the provider in `config.json`).                                                                                                                                                                              |
| `JAZZ_REASONING`                     | `medium`                                | `disable`\|`low`\|`medium`\|`high`.                                                                                                                                                                                                                         |
| `OLLAMA_BASE_URL`                    | `http://host.docker.internal:11434/api` | Ollama endpoint (only for `provider=ollama` / `/model`).                                                                                                                                                                                                    |
| `JAZZ_APPROVAL_POLICY`               | `low-risk`                              | Auto-approve tools up to: `read-only`\|`low-risk`\|`high-risk`.                                                                                                                                                                                             |
| `JAZZ_AUTO_APPROVE_TOOLS`            | —                                       | Comma-separated tool names to auto-approve regardless of policy (e.g. `execute_command`) — narrower than raising the whole tier. Tools needing approval that aren't in this list are sent to the chat as an accept/reject prompt instead of being declined. |
| `JAZZ_RUN_TIMEOUT_MS`                | `300000`                                | Per-message agent timeout.                                                                                                                                                                                                                                  |
| `TELEGRAM_MODE`                      | `polling`                               | `polling` or `webhook`.                                                                                                                                                                                                                                     |
| `PORT`                               | `8080`                                  | In-container health-check port.                                                                                                                                                                                                                             |
| `TELEGRAM_WEBAPP_BASE_URL`           | webhook URL's origin, else unset        | Public HTTPS origin used to serve `create_web_app`'s "interactive" pages as Telegram Web App buttons. Unset disables interactive mode (the static/image mode always works).                                                                                 |
| `PUPPETEER_EXECUTABLE_PATH`          | `/usr/bin/chromium`                     | Browser used to screenshot `create_web_app`'s "static" mode. The image installs Chromium and points here; Jazz ships no bundled browser. Interactive mode needs no browser.                                                                                 |

> **Model ↔ reasoning:** reasoning-capable models (`gpt-5.4`, qwen3, …) work with
> `medium`/`high`; models without it (mistral-small, gemma, …) error unless
> reasoning is `disable`. `/model` sets this automatically for Ollama models.

## How it works

For each allowed message the bridge runs:

```sh
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
