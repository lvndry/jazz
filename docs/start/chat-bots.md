---
description: "Step-by-step: create a Telegram bot or a Discord bot, wire it to a Jazz agent, and run it. Covers tokens, allowlists, .env, docker compose, and switching providers/models at runtime."
---

# Creating a Telegram or Discord bot

A hands-on walkthrough for going from nothing to a working Jazz agent in your Telegram DMs
or a Discord server. Both bridges are shipped, Docker-based services — this page is the
account-creation and configuration steps; see
[Chat platforms](../use-cases/chat-platforms.md) for what they demonstrate architecturally,
and each bridge's own README for the full command/environment-variable reference:
[`packages/telegram-bot/README.md`](../../packages/telegram-bot/README.md),
[`packages/discord-bot/README.md`](../../packages/discord-bot/README.md).

You need Docker + Docker Compose, and a model backend — an API key for a cloud provider
(OpenAI by default), or a local [Ollama](https://ollama.com) with a tool-capable model
pulled.

---

## Telegram

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather) on Telegram:

1. Send `/newbot`.
2. Pick a display name, then a username ending in `bot` (e.g. `my_jazz_bot`).
3. BotFather replies with a token that looks like `123456:ABC-DEF...`. That's
   `TELEGRAM_BOT_TOKEN` — treat it like a password.

### 2. Get your chat id

Message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric id. That's
what goes on the allowlist so the bot only answers you (and anyone else you add).

### 3. Configure

```bash
cd packages/telegram-bot/src
cp .env.example .env
```

Edit `.env` and set at least:

- `TELEGRAM_BOT_TOKEN` — from step 1.
- `TELEGRAM_ALLOWED_CHAT_IDS` — your id from step 2 (comma-separated if more than one).
- A model backend — `OPENAI_API_KEY` is set by default (`JAZZ_TELEGRAM_PROVIDER=openai`,
  `JAZZ_TELEGRAM_MODEL=gpt-5.4`). To run fully local instead, set
  `JAZZ_TELEGRAM_PROVIDER=ollama` and `JAZZ_TELEGRAM_MODEL=<a model you've pulled>`.

### 4. Run it

The image builds Jazz from the repo source, so the compose build context is the repo root
(already wired — no extra setup needed):

```bash
docker compose up -d --build
docker compose logs -f          # expect "Polling Telegram for updates…"
```

### 5. Talk to it

Message your bot on Telegram. It shows a "typing…" indicator, then the agent's reply.

If nothing happens: check your chat id is actually on `TELEGRAM_ALLOWED_CHAT_IDS`, and that
`docker compose logs` doesn't show an auth error from Telegram (a copy-pasted token with a
trailing space is the usual culprit).

---

## Discord

### 1. Create the application and bot

1. Open the [Discord developer portal](https://discord.com/developers/applications) and
   sign in.
2. **New Application** → name it (e.g. `Jazz`) → Create.
3. Left sidebar → **Bot** → **Reset Token** → copy it. That's `DISCORD_BOT_TOKEN` —
   treat it like a password.
4. Still on the Bot page, under **Privileged Gateway Intents**, turn on **Message Content
   Intent** and Save. Without this the bot cannot read what people type in a server.
5. Left sidebar → **OAuth2** → copy the **Client ID** (also called Application ID) — you'll
   need it for the invite URL in the next step.

### 2. Invite it to your server

You need permission to add bots on that server (owner, or Manage Server).

Open this URL, replacing `YOUR_APP_ID` with the Client ID from step 1:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=311385246720
```

Pick your server → Authorize. The bot appears in the member list, offline until the bridge
is running. Those permissions are: View Channel, Send Messages, Send Messages in Threads,
Create Public Threads, Embed Links, Attach Files, Read Message History, Use Application
Commands.

To restrict it to one channel: after inviting, edit that channel's permissions to allow the
bot role there, and deny (or don't grant) View Channel everywhere else. Then put that
channel's id on the allowlist below instead of a server id.

### 3. Copy ids for the allowlist

In Discord: **User Settings → Advanced → Developer Mode** (on). Then right-click and
**Copy … ID**:

| You want…                       | Right-click                           |
| -------------------------------- | -------------------------------------- |
| Yourself (DMs + your @mentions)  | your avatar / username → Copy User ID  |
| One channel only                 | the channel → Copy Channel ID          |
| The whole server                 | the server name → Copy Server ID       |

For a private server, the usual choice is `DISCORD_ALLOWED_GUILD_IDS=<server id>` (anyone in
the server can @mention the bot), or `DISCORD_ALLOWED_USER_IDS=<your id>` (only you, in DMs
and in any server the bot is in).

### 4. Configure

```bash
cd packages/discord-bot/src
cp .env.example .env
```

Edit `.env` and set at least:

- `DISCORD_BOT_TOKEN` — from step 1.
- One allowlist: `DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_CHANNEL_IDS`, and/or
  `DISCORD_ALLOWED_GUILD_IDS`.
- A model backend — `OPENAI_API_KEY` is set by default (`JAZZ_DISCORD_PROVIDER=openai`,
  `JAZZ_DISCORD_MODEL=gpt-5.4`). To run fully local instead, set
  `JAZZ_DISCORD_PROVIDER=ollama` and `JAZZ_DISCORD_MODEL=<a model you've pulled>`.

### 5. Run it

```bash
docker compose up -d --build
docker compose logs -f          # expect "Discord → Jazz bridge ready as @…"
```

### 6. Talk to it

- **In the server:** `@Jazz what's the weather in Lyon` — it starts a thread and replies
  there. Follow-ups in that thread don't need another mention.
- **DMs:** only if your user id is on `DISCORD_ALLOWED_USER_IDS`.
- **Slash commands** (`/help`, `/status`, `/tz`, …) show up in the server a few seconds
  after the bridge logs "ready".

If it stays silent in the server: Message Content Intent is off, the channel isn't
allowlisted, or you didn't @mention it (`DISCORD_REQUIRE_MENTION=1` by default).

---

## Adding more providers

Both bridges start on one provider (`OPENAI_API_KEY`/`gpt-5.4` by default), but `/model`
can switch a conversation to any of the ~18 providers Jazz supports — Anthropic, Gemini,
xAI, OpenRouter, Groq, and more — without touching `JAZZ_TELEGRAM_PROVIDER`/
`JAZZ_DISCORD_PROVIDER` (those only set what a brand-new conversation starts on).

To enable a provider for `/model`, set its API key as an env var on the bot and restart the
container — `.env.example` lists the full set (`ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, …). Then,
as a normal message in the chat:

```text
/model anthropic/claude-sonnet-5
```

Bare `/model` (no arguments) instead shows a picker of whatever the conversation's current
provider offers. Reasoning effort is set automatically either way.

---

## Keeping it updated

Both bots ship an `auto-update.sh` that fast-forwards the checkout to `origin/main`,
rebuilds only if something changed, and rolls back if the new build doesn't come up
healthy. Install it as a nightly cron job (adjust the path to where you cloned the repo):

```bash
(crontab -l 2>/dev/null; echo "30 4 * * * $HOME/jazz/packages/telegram-bot/src/auto-update.sh >> $HOME/jazz-autoupdate.log 2>&1") | crontab -
```

Swap `telegram-bot` for `discord-bot` to update the other one. A sibling executable
`notify.sh` — present in both directories — posts the outcome (success, rollback, or a
build that needs a look) back to the bot's own chat/channel, so a failed deploy doesn't sit
silently in a logfile.
