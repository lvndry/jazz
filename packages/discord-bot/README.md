# Discord bridge

Chat with a [Jazz](../../README.md) agent from Discord. A small Bun service
bridges Discord to the `jazz` CLI: every message runs the agent once and replies
with the answer — with per-conversation model/persona switching, per-channel
memory, mention-gating in servers, and thread-bound guild chats.

Works with any Jazz provider. **Defaults to OpenAI `gpt-5.4`**; point it at a
local [Ollama](https://ollama.com) instead for fully self-hosted, no-cloud use.

```text
Discord  ◀──(Gateway websocket)──▶  bridge  ──jazz run --json──▶  OpenAI / Ollama / …
```

## Features

- 🤖 **Any Jazz agent over Discord** — a full tool-using agent, not an echo bot.
- 🔌 **Bring your own model** — OpenAI `gpt-5.4` out of the box, or any provider Jazz supports (including local Ollama).
- 🎛️ **Per-conversation `/model` and `/persona`** — each DM or thread picks its own via select menus; choices persist.
- 🧵 **Thread binding in servers** — `@mention` in a channel starts a thread; follow-ups in that thread don't need another mention.
- 🤫 **Mention-gating** — in servers the bot ignores chatter unless mentioned, replied-to, or already in the thread. DMs always respond.
- 📡 **Live progress** — a status message updates in real time with thinking, tool calls, sub-agents (🤖), and tools awaiting approval (⛔); it closes with a `✅ Done · tools · tokens · $cost` summary, and the answer lands as a new message.
- ⏰ **Reminders** — `/remind` or plain language ("remind me in 2 hours …"), scheduled by the agent via a native tool, resolved in your timezone (`/tz`) and delivered even across restarts.
- 💬 **Per-channel memory**, 🔒 **allowlist-gated**, 🐳 **one-command Docker deploy**.

## Requirements

- Docker + Docker Compose.
- A Discord bot token from the [developer portal](https://discord.com/developers/applications).
- A model backend — **either** an API key for a cloud provider (OpenAI by default)
  **or** a local [Ollama](https://ollama.com) with a tool-capable model pulled.
- Outbound HTTPS/WSS to `discord.com` / `gateway.discord.gg`. No public inbound port
  (the Gateway connection is outbound).

## Quick start

### 1. Create the Discord application

1. Open the [Discord developer portal](https://discord.com/developers/applications) and
   sign in.
2. **New Application** → name it (e.g. `Jazz`) → Create.
3. Left sidebar → **Bot** → **Reset Token** → copy the token. That’s
   `DISCORD_BOT_TOKEN`. Treat it like a password.
4. On the same Bot page, under **Privileged Gateway Intents**, turn on
   **Message Content Intent** and Save. Without this the bot cannot read what
   people type in a server.
5. Left sidebar → **OAuth2** → copy **Client ID** (also called Application ID).
   You’ll paste it into the invite URL below.

### 2. Invite it to your server

You must be able to add bots on that server (owner, or Manage Server).

Open this URL in a browser, replacing `YOUR_APP_ID` with the Client ID from step 1:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=311385246720
```

Pick your server → Authorize. The bot appears in the member list, offline until
the bridge is running.

Those permissions are: View Channel, Send Messages, Send Messages in Threads,
Create Public Threads, Embed Links, Attach Files, Read Message History, Use
Application Commands.

If you only want it in one channel: after inviting, edit that channel’s
permissions and allow the bot role there; deny it (or don’t grant View Channel)
everywhere else. Then put that channel’s id on the allowlist in step 3.

### 3. Copy ids for the allowlist

In Discord: **User Settings → Advanced → Developer Mode** (on).

Then right-click and **Copy … ID**:

| You want… | Right-click |
| --- | --- |
| Yourself (DMs + your @mentions) | your avatar / username → Copy User ID |
| One channel only | the channel → Copy Channel ID |
| The whole server | the server name → Copy Server ID |

For a private server the usual choice is `DISCORD_ALLOWED_GUILD_IDS=<server id>`
(anyone in the server can @mention the bot) **or** `DISCORD_ALLOWED_USER_IDS=<your id>`
(only you, in DMs and in any server the bot is in).

### 4. Configure and run the bridge

From this directory (`integrations/discord-bot/` in the Jazz repo):

```sh
cp .env.example .env
```

Set at least:

- `DISCORD_BOT_TOKEN`
- one allowlist: `DISCORD_ALLOWED_USER_IDS` and/or `DISCORD_ALLOWED_CHANNEL_IDS`
  and/or `DISCORD_ALLOWED_GUILD_IDS`
- a model backend — by default `OPENAI_API_KEY` (uses `gpt-5.4`). To go local
  instead, set `JAZZ_DISCORD_PROVIDER=ollama` + `JAZZ_DISCORD_MODEL=<pulled model>`.

The image builds Jazz from the repo source, so the compose build context is the
repo root (already wired):

```sh
docker compose up -d --build
docker compose logs -f          # expect "Discord → Jazz bridge ready as @…"
```

### 5. Talk to it

- **In the server:** `@Jazz what's the weather in Lyon` — it starts a thread and
  replies there. Follow-ups in that thread don’t need another mention.
- **Slash commands** (`/help`, `/status`, `/tz`, …) work in the server as soon
  as the bridge has registered them (a few seconds after “ready”).
- **DMs:** only if your user id is on `DISCORD_ALLOWED_USER_IDS`.

If it stays silent in the server: Message Content Intent off, channel not
allowlisted, or you didn’t @mention it (`DISCORD_REQUIRE_MENTION=1` by default).

## Commands

| Command | What it does |
| --- | --- |
| _(DM, or @mention in a server)_ | Answered by your agent |
| `/model` | Select menu of models pulled in Ollama — pick one (switches this conversation to that local model) |
| `/persona` | Select menu of available personas |
| `/new` | Start a fresh conversation — clears earlier context; keeps your model/persona |
| `/incognito` | Private conversation (nothing saved to history or memory) until `/new` |
| `/remind` | Schedule a reminder. `when` = `30m`, `1h30m`, `18:00`, `tomorrow 09:00`, `tue 20:00`, or `2026-08-25 20:00`. Routed through a normal agent turn, which calls the `add_reminder` tool. |
| _(natural language)_ | Just say it — "remind me to call the dentist in 2 hours". The agent calls `add_reminder` itself. |
| `/reminders` | List your pending reminders (in your timezone); tap one to cancel |
| `/tz` | Show or set your timezone (IANA name, e.g. `/tz zone:Europe/Paris`) so reminder times are local |
| `/status` | Current model, your timezone, today's runs/tokens/cost, daily cap, uptime |
| `/help` | Usage |

While a message is processing, the progress message carries a **⏹ Cancel**
button that kills the run. Each answer gets follow-up buttons (`🔍 Go deeper`,
`✂️ Shorter`, …) that upgrade to contextual ones a beat later; set
`JAZZ_DISCORD_DYNAMIC_CTA=0` to keep only the static ones.
The 💭 line on the progress message is only the tail of the model's current
thought, and that message is replaced when the answer lands — so the full
reasoning follows the answer as **Reasoning** spoilers you click to reveal.
Very long runs are split across a few spoilers, and the last one says how much
was left out; set `JAZZ_DISCORD_SHOW_REASONING=0` to drop them.
Set `JAZZ_DAILY_COST_CAP_USD` to cap known spend per UTC day (0 = no cap).
If a completed run has no pricing metadata, its exact cost cannot be capped;
the bot records it as unpriced and pauses later requests until the next UTC day.

**Servers vs DMs.** In a server the bot only answers when mentioned, when you
reply to it, or in a thread it already joined (`DISCORD_REQUIRE_MENTION=1`,
the default). An `@mention` in a channel starts a thread so the rest of the
room is not the conversation. DMs skip mention-gating.

**Timezone.** Reminder times are resolved per channel: an explicit `/tz`
choice, the container's `TZ`, then UTC. Each `jazz run` is invoked with
`--timezone <zone>`, so `18:00` means 6pm where you set it, across DST.

Reminders are stored per Discord channel's agent, one JSON file per agent under
`reminders/` in the Jazz home directory (`reminders/dc_<channel_id>.json`),
written by the `add_reminder`/`cancel_reminder` tools rather than the bridge
itself. A sweep delivers due reminders every 20s, so they survive restarts
(one due while the bridge was down fires on next start, marked `(delayed)`).

Each DM or thread gets an independent agent (`dc_<channel_id>.json`, cloned from
the `discord` template on first contact), so `/model` and `/persona` change only
_that_ conversation. `JAZZ_DISCORD_PROVIDER` / `JAZZ_DISCORD_MODEL` /
`JAZZ_REASONING` set the defaults new conversations start from.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | — | **Required.** Bot token from the developer portal. |
| `DISCORD_ALLOWED_USER_IDS` | — | Comma-separated user ids. Required for DMs; also gates guild senders when set. |
| `DISCORD_ALLOWED_CHANNEL_IDS` | — | Comma-separated channel ids (threads of these channels inherit). |
| `DISCORD_ALLOWED_GUILD_IDS` | — | Comma-separated server ids. At least one of the three allowlists is required. |
| `DISCORD_REQUIRE_MENTION` | `1` | In servers, only respond to mentions / replies / existing threads. |
| `DISCORD_CREATE_THREADS` | `1` | `@mention` in a channel starts a thread and keeps the conversation there. |
| `JAZZ_DISCORD_PROVIDER` | `openai` | LLM provider. |
| `JAZZ_DISCORD_MODEL` | `gpt-5.4` | Default model id for the provider. |
| `OPENAI_API_KEY` (or provider's key) | — | API key for the chosen provider. Not needed for `ollama`. |
| `BRAVE_API_KEY` | — | If set, `web_search` uses Brave. |
| `JAZZ_OLLAMA_KEEP_ALIVE` | — | How long a local Ollama keeps the model loaded (`keep_alive`): `-1` pins it indefinitely, or a duration like `30m`. Unset uses Ollama's 5-minute default, so the first message after a quiet spell pays a full cold model load with no progress shown while it happens. |
| `JAZZ_REASONING` | `medium` | `disable`\|`low`\|`medium`\|`high`. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434/api` | Ollama endpoint (only for `provider=ollama` / `/model`). |
| `JAZZ_APPROVAL_POLICY` | `low-risk` | Auto-approve tools up to: `read-only`\|`low-risk`\|`high-risk`. |
| `JAZZ_AUTO_APPROVE_TOOLS` | — | Comma-separated tool names to auto-approve regardless of policy. Tools needing approval that aren't in this list are sent to the channel as an accept/reject prompt instead of being declined. |
| `JAZZ_RUN_TIMEOUT_MS` | `300000` | Per-message agent timeout. |
| `JAZZ_DAILY_COST_CAP_USD` | `0` | Daily known-spend ceiling across all conversations; an unpriced run pauses later requests for the UTC day; `0` disables the cap. |
| `DISCORD_PUBLIC_BASE_URL` | unset | Public HTTPS origin used to link `create_web_app`'s interactive pages. Unset disables interactive mode (static/image mode always works). |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Browser used to screenshot `create_web_app`'s "static" mode. |

> **Model ↔ reasoning:** reasoning-capable models (`gpt-5.4`, qwen3, …) work with
> `medium`/`high`; models without it (mistral-small, gemma, …) error unless
> reasoning is `disable`. `/model` sets this automatically for Ollama models.

## How it works

For each allowed message the bridge runs:

```sh
jazz run --no-tui --json --agent dc_<channel_id> --conversation <channel_id> "<text>"
```

`--conversation` gives per-channel memory; the per-channel agent file supplies
the provider/model/persona. Data lives in the `jazz_discord_data` volume
(`JAZZ_HOME=/data`): agents in `/data/agents`, transcripts in `/data/history`
(keyed by channel id, **plaintext JSON** — treat the volume as sensitive), logs
in `/data/logs`.

The Gateway connection is outbound-only. Slash command and button interactions
are acknowledged within Discord's 3-second deadline, then the agent run continues
asynchronously.

## Updating Jazz

The image builds Jazz **from this repo's source** at `docker compose up --build`
time, so the deployed version is pinned to the checkout's commit — it does **not**
update on its own. To update manually:

```sh
cd <repo> && git pull origin main
cd integrations/discord-bot && docker compose -p jazz-discord up -d --build
```

**Nightly auto-update:** `auto-update.sh` fast-forwards to the latest `origin/main`,
rebuilds only if it changed, and rolls back if the new build fails to build or
isn't healthy. Install it (as the deploy user):

```sh
(crontab -l 2>/dev/null; echo "30 4 * * * $HOME/jazz/integrations/discord-bot/auto-update.sh >> $HOME/jazz-autoupdate.log 2>&1") | crontab -
```

**Sending yourself a message:** `notify.sh` posts one message to the first allowed
chat, reading the token from this directory's `.env`. It starts no run and calls no
model, so it costs nothing and works even while the agent is busy or down:

```sh
./notify.sh "backup finished, 41 GB, no errors"
./long-job.sh && ./notify.sh "done" || ./notify.sh "FAILED ($?)"
```

Anything on the host can use it — scripts, cron, a finished job, you at a shell.
`auto-update.sh` uses it to report failures. See
[Chat platforms — sending yourself a message](../../docs/surfaces/chat-platforms.md#sending-yourself-a-message).

**Run logs:** every turn appends an NDJSON record of the jazz event stream to
`<JAZZ_HOME>/logs/runs/<conversation>-<timestamp>.ndjson`, written as the run
happens rather than when it finishes — so a run that times out still leaves a
trace. Each line carries elapsed time, token deltas are collapsed into one line
per stream with a character count and duration, and the last line is the outcome
with the number of model rounds. The newest 200 runs per bridge are kept.

Anything needing a human is also sent to the bridge's own chat via `notify.sh`,
because a nightly cron failure that only appends to a logfile is invisible: a
checkout left on a feature branch silently skipped every update for over two
weeks before anyone noticed. If the checkout isn't on `main`, the script parks it
back there — stashing tracked edits (untracked files such as a local
`docker-compose.override.yml` are left alone) and reporting both the stash and any
commits left behind on the old branch by name, so nothing goes quietly missing.
Set `JAZZ_DEPLOY_BRANCH` to track something other than `main`.

## Security notes

- Only allowlisted users / channels / guilds are answered; everyone else is ignored
  (slash commands from strangers get an ephemeral denial).
- In servers, mention-gating is the second gate: a busy allowlisted channel does
  not become an unbounded `jazz run` bill. Do not set `DISCORD_REQUIRE_MENTION=0`
  unless the channel is private and you mean it.
- The agent ships with the **full toolset** — filesystem (incl. write/delete),
  `execute_command`, git (incl. push), HTTP, and web search — and runs
  **without a human in the loop**. `JAZZ_APPROVAL_POLICY` is the gate: at the
  default `low-risk`, higher-risk actions (shell, delete, push, …) are
  auto-declined; raise it to `high-risk` only if you understand that a prompt
  (or prompt injection) could then run arbitrary commands on the host. Trim the
  toolset in `agent.discord.json` if you want a smaller blast radius.
- Agent replies are sent with `allowed_mentions.parse = []` so the model cannot
  ping `@everyone`, `@here`, or arbitrary users.
