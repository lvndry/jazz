---
description: "Step-by-step: reach a Jazz agent from Telegram, Discord, iMessage or WhatsApp. Covers tokens, pairing, allowlists, macOS permissions, and switching providers/models at runtime."
---

# Reaching your agent from a chat app

A hands-on walkthrough for going from nothing to a working Jazz agent in your Telegram DMs,
a Discord server, Messages on a Mac, or WhatsApp. See
[Chat platforms](../use-cases/chat-platforms.md) for what they demonstrate architecturally,
and each bridge's own README for the full command/environment-variable reference:
[Telegram](../../packages/telegram-bot/README.md),
[Discord](../../packages/discord-bot/README.md),
[iMessage](../../packages/imessage-bot/README.md),
[WhatsApp](../../packages/whatsapp-bot/README.md).

All four give you the same thing: per-chat memory, per-chat `/model` and `/persona`,
reminders, and attachments. They differ in where they can run and what the app can show.
Telegram and Discord are Docker services you can put on a server. iMessage only exists on a
Mac, so its bridge runs there as a background service. WhatsApp links to your account the
way WhatsApp Web does.

You need a model backend for any of them — an API key for a cloud provider (OpenAI by
default), or a local [Ollama](https://ollama.com) with a tool-capable model pulled.
Telegram and Discord additionally need Docker + Docker Compose.

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
| ------------------------------- | ------------------------------------- |
| Yourself (DMs + your @mentions) | your avatar / username → Copy User ID |
| One channel only                | the channel → Copy Channel ID         |
| The whole server                | the server name → Copy Server ID      |

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

## iMessage

Runs on a Mac running macOS 14 or newer, signed into iMessage, awake and logged in — there
is no server-side option, because iMessage exists nowhere else. The agent answers on **your**
Apple account: the same line your friends already text.

### 1. Start it

```bash
jazz imessage
```

The first run of this command is where setup happens, and nowhere earlier —
installing Jazz never asks about iMessage, because a request for Full Disk
Access from something you did not ask for is alarming rather than helpful.

To answer as an agent you already have rather than a fresh assistant, name it — it is copied
into the bridge's own home, so the original keeps its name and stays yours:

```bash
jazz imessage --agent nostra
```

### 2. Say yes twice

It walks through the two things it needs:

- **`imsg`**, the CLI it reads and sends Messages through. It offers to install it.
- **Full Disk Access**, so it can read your Messages. macOS keeps them in a protected
  database and this is the only permission that opens it. Jazz opens the right settings
  page and copies the path you need to add — click `+`, press `Cmd-Shift-G`, paste, then
  run it again.

The first message it sends also raises a one-time Automation → Messages prompt.

### 3. Talk to it

With nothing configured, a first run answers only you: text **yourself**
`jazz <question>` from any of your devices. That is `IMESSAGE_SELF_TRIGGER` falling back to
`jazz` precisely because no allow-list is set — it opens the bridge to one person, whoever is
already signed in on this Mac, and to nobody else.

Two consequences of borrowing your own account, both visible in the chat:

- **A trigger word is needed for messages to yourself.** iMessage marks everything you send
  as yours, the bridge's own replies included, so in a chat with yourself it has to be told
  which lines are questions. Texts from other allowed handles need no prefix.
- **No live progress, and approvals are numbered replies.** iMessage cannot edit a sent
  message, so you get `🤔 Working…` then the answer, and a tool that needs a human arrives as
  numbered options you answer with `1` or `2`.

### 4. Let it run in the background

Once it answers, it offers to install itself as a LaunchAgent and hands over. From then on it
starts at login and restarts itself if it dies.

```bash
jazz imessage status   # installed? running?
jazz imessage logs     # follow it ($JAZZ_HOME/bridge.log)
jazz imessage stop     # stop it
```

Granting Full Disk Access to the service rather than to your terminal is worth doing:
macOS attributes the access to whatever started the process, so a terminal grant covers
every command you run there while the service grant covers only this bridge.

**Set the allow-list before you accept the install.** The plist is written from the
environment at install time — `IMESSAGE_ALLOWED_HANDLES`, `JAZZ_HOME`, `JAZZ_IMESSAGE_MODEL`
and the rest are snapshotted into it, and it is never overwritten afterwards. To change any
of them later: `jazz imessage stop`, delete
`~/Library/LaunchAgents/com.github.lvndry.jazz.imessage.plist`, then run `jazz imessage`
again with the new values (or edit that file by hand). Provider API keys are deliberately not
carried — the agent reads those from the OS keyring itself.

### 5. Let other people in

```bash
IMESSAGE_ALLOWED_HANDLES="+15551234567,friend@icloud.com" jazz imessage
```

Deny-by-default, because this answers on a phone number anyone can text. A message from an
unlisted number is logged and never answered. Group chats are admitted by their own
`chat.db` rowid (`IMESSAGE_ALLOWED_GROUP_CHAT_IDS`) — being allowed to DM the agent does not
put it in your group chats.

Once any allow-list is set, the `jazz` self-trigger stops being assumed; set
`IMESSAGE_SELF_TRIGGER=jazz` explicitly to keep texting yourself as well. Started without a
terminal — which is what the background service is — and with nothing allowed, the bridge
refuses to start rather than answer a number anyone can text.

Full variable table: [`packages/imessage-bot/README.md`](../../packages/imessage-bot/README.md).
If you would rather the agent had a line of its own than share yours, there is a third
option on this front — see [`packages/photon-bot/README.md`](../../packages/photon-bot/README.md).

---

## WhatsApp

The bridge links to your WhatsApp account as a device, exactly as WhatsApp Web does. It runs
wherever you are, not in a container, and it has no background installer: keep the process
alive yourself (a terminal you leave open, `tmux`, or your init system of choice).

### 1. Start it

```bash
jazz whatsapp
```

From a checkout without an installed binary, `bun packages/whatsapp-bot/src/main.ts` is the
same thing. `--agent nostra` seeds it from an agent you already have, copied into the
bridge's own home.

On the first run it asks whose messages the agent should answer and remembers the answer in
`wa-allowed.json` under its home. To skip the question — which is what you want on a server,
where the bridge refuses to start rather than ask a terminal that is not there:

```bash
WHATSAPP_ALLOWED_NUMBERS="+15551234567,+33123456789" jazz whatsapp
```

The environment wins over the saved answer, which wins over asking.

### 2. Pair it

It prints a QR code: WhatsApp → Settings → Linked Devices → Link a device. Scan the one on
screen promptly — WhatsApp expires each code after about a minute and prints another, and a
stale one is refused with "check your connection".

On a machine with no screen to point a phone at, set `WHATSAPP_PAIR_NUMBER` to the account's
own number and it prints an 8-character code to type in under **Link with phone number**
instead.

Pairing happens once. The linked-device credentials land in `WHATSAPP_AUTH_DIR`
(`$JAZZ_HOME/wa-auth` by default, where `JAZZ_HOME` is `~/.jazz-whatsapp`) — anything that
can read that directory can act as the account.

### 3. Talk to it

DM the linked account from any allowed number. Approvals and questions arrive as numbered
options you answer by replying with a number: WhatsApp buttons are restricted to business
accounts and degrade to nothing on a personal one.

### 4. Groups

An allowed group (`WHATSAPP_ALLOWED_GROUPS`, by JID) still needs the bot @-mentioned or
replied to before it answers, so it can sit in a busy thread without joining in. Turn that
off with `WHATSAPP_REQUIRE_MENTION_IN_GROUPS=0` if you want it answering everything. Being
allowed to DM the agent does not admit you to a group, and the reverse is also true — but
inside an allowed group the number list is not consulted at all, so everyone in that thread
can address the agent.

Group JIDs look like `120363043211234567@g.us`. The simplest way to get one is to run the
bridge, send a message in the group, and read the line it logs about ignoring a message from
a group that is not on the list.

### What to know before you rely on it

WhatsApp publishes no API for personal accounts, so this speaks the WhatsApp Web protocol
via [Baileys](https://github.com/WhiskeySockets/Baileys) — capable, but not sanctioned by
Meta. A number that behaves unusually can be rate-limited or banned, so use a dedicated
number if the account matters. Unlinking the device from your phone ends the session and
the bridge says so and exits. And it is a full device: everything that account receives, this
process receives — the allow-list decides what it _answers_, not what it _sees_.

The official alternative, the WhatsApp Cloud API, needs a Meta Business account and a
separate business number, and only allows template messages outside a 24-hour reply window
— which is why it is not what this uses.

Full variable table: [`packages/whatsapp-bot/README.md`](../../packages/whatsapp-bot/README.md).

---

## Adding more providers

Every bridge starts on one provider (`OPENAI_API_KEY`/`gpt-5.4` by default), but `/model`
can switch a conversation to any of the ~18 providers Jazz supports — Anthropic, Gemini,
xAI, OpenRouter, Groq, and more — without touching `JAZZ_TELEGRAM_PROVIDER`,
`JAZZ_DISCORD_PROVIDER`, `JAZZ_IMESSAGE_PROVIDER` or `JAZZ_WHATSAPP_PROVIDER` (those only
set what a brand-new conversation starts on).

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

The Telegram and Discord bots ship an `auto-update.sh` that fast-forwards the checkout to `origin/main`,
rebuilds only if something changed, and rolls back if the new build doesn't come up
healthy. Install it as an hourly cron job (adjust the path to where you cloned the repo):

```bash
(crontab -l 2>/dev/null; echo "30 * * * * $HOME/jazz/packages/telegram-bot/src/auto-update.sh >> $HOME/jazz-autoupdate.log 2>&1") | crontab -
```

Swap `telegram-bot` for `discord-bot` to update the other one. A sibling executable
`notify.sh` — present in both directories — posts the outcome (success, rollback, or a
build that needs a look) back to the bot's own chat/channel, so a failed deploy doesn't sit
silently in a logfile.
