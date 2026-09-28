---
description: "Run a real tool-using AI agent inside Telegram, Discord, iMessage, WhatsApp, Slack, or your own app: same agent, same tools, same approval rules as the terminal."
---

# Chat platforms. Telegram, Discord, iMessage, WhatsApp, your own app

How to put a real tool-using agent into a chat thread.

A Jazz agent in a chat window isn't a chatbot with your logo on it. It's the same agent
that reads your filesystem, runs git, searches the web, and spawns sub-agents: reachable
from your phone.

| Platform         | Status                          | Where                                                                                                             |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Telegram**     | ✅ Shipped containerized bridge | [`packages/telegram-bot/`](../../packages/telegram-bot/)                                                          |
| **Discord**      | ✅ Shipped containerized bridge | [`packages/discord-bot/`](../../packages/discord-bot/)                                                            |
| **iMessage**     | ✅ Hosted or local-Mac bridge   | [`packages/photon-bot/`](../../packages/photon-bot/) and [`packages/imessage-bot/`](../../packages/imessage-bot/) |
| **WhatsApp**     | ✅ Shipped, linked device       | [`packages/whatsapp-bot/`](../../packages/whatsapp-bot/), `jazz whatsapp`                                         |
| **Slack**        | 🔧 Bring your own bridge        | pattern below                                                                                                     |
| **Google Chat**  | 🔧 Bring your own bridge        | pattern below                                                                                                     |
| **Your own app** | 🔧 Bring your own bridge        | pattern below                                                                                                     |

**Be clear on what ships.** Every bridge runs on one shared turn core
(`packages/bot-shared/src/turn.ts`): one run at a time per conversation, the same commands
(`/new`, `/model`, `/persona`, `/mode`, `/remind`, `/reminders`, `/tz`, `/status`), the same
approval rules, and whatever the platform can show on top (buttons, an edited progress bubble).
Telegram and Discord are containerized services with per-conversation model switching,
reminders, and live progress. WhatsApp ships as a linked-device
command. iMessage has two implementations: Photon provides a hosted line with no Mac required;
`--local` uses your own Apple account on a Mac. Slack and Google Chat do not ship an adapter.

---

## The bridge pattern

Every chat bridge is the same three responsibilities. Only the middle one is
platform-specific.

```mermaid
flowchart TB
    subgraph platform["Your platform adapter"]
        direction TB
        IN["Receive a message<br/>webhook or long-poll"]
        AUTH["Authorize the sender<br/>allowlist"]
        FMT["Format the reply<br/>markdown → mrkdwn / HTML / embeds"]
        OUT["Post the reply"]
    end

    subgraph jazz["Jazz (zero lines)"]
        direction TB
        RUN["<b>jazz run --json</b><br/>--conversation chat-id<br/>--approval-policy low-risk"]
        MEM["History, tools, skills,<br/>model, cost accounting"]
    end

    IN --> AUTH
    AUTH -->|allowed| RUN
    AUTH -->|denied| DROP["Ignore"]
    RUN --> MEM
    MEM --> RUN
    RUN --> FMT
    FMT --> OUT

    classDef mine fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    classDef theirs fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    class IN,AUTH,FMT,OUT,DROP mine
    class RUN,MEM theirs
```

You write the orange boxes. You do not write session storage, context management, tool
dispatch, approval logic, or cost tracking. `--conversation` and `--approval-policy`
cover those. See [Headless](./headless.md) for the contract in full.

---

## Telegram (shipped)

```bash
cd packages/telegram-bot/src
cp .env.example .env     # set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_IDS + a model key
docker compose up -d --build
```

That's a working agent in your DMs. For the account-creation steps (bot token, chat id),
see [Reaching your agent from a chat app](../guides/deploy-a-chat-agent.md); for the full
configuration table and security notes, see
[`packages/telegram-bot/README.md`](../../packages/telegram-bot/README.md).

What the Telegram bridge demonstrates: worth reading before you write your own:

| Feature                   | How it works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-user agents**       | Each chat gets `tg_<chat_id>.json`, cloned from a template on first contact. `/model` and `/persona` change only that user's experience.                                                                                                                                                                                                                                                                                                                                                          |
| **Per-user isolation**    | Each chat's agent runs as its own Unix user, in its own Jazz home under `/data/chats/tg_<chat_id>/`. One allowlisted person's agent cannot read another's transcripts, memory, stored secrets or mail credentials: the kernel refuses, rather than a filename convention discouraging it. Every chat does share the provider API keys the bridge was given (they are in each run's environment), so every chat bills the operator's accounts. The bot token and bridge secrets never reach a run. |
| **Any-provider `/model`** | Bare `/model` lists the current provider's models; `/model provider/model` (e.g. `/model openrouter/z-ai/glm-5.3-flash`) switches to any provider Jazz supports: set that provider's API key as an env var on the bot first (see `.env.example`).                                                                                                                                                                                                                                                 |
| **Per-chat memory**       | `--conversation <chat_id>`. The bridge itself is stateless.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Live progress**         | `--events` NDJSON on stderr drives a status bubble that updates with thinking, tool calls, and sub-agents, then closes with a `✅ Done · 7 tools · 12k tokens · $0.03` summary.                                                                                                                                                                                                                                                                                                                   |
| **Cancellation**          | A ⏹ button kills the child process mid-run.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Approvals**             | Each tool needing a human gets its own accept/reject message, answered only by the person whose message started the run. A parallel batch of tool calls grows **⚡ Approve all N** / **🚫 Reject all N** so the whole batch clears in one tap, and an operator's `/mode yolo` opts a conversation out of prompting altogether (yolo runs at `high-risk`). Both bridges do this.                                                                                                                   |
| **Reminders**             | `/remind 30m …`, persisted to disk so they survive restarts and fire late if the bridge was down.                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Spend cap**             | `JAZZ_DAILY_COST_CAP_USD`: known `costUSD` is accumulated per day; after an unpriced run, further requests pause until the next local day. Runs are recorded in the spend ledger `jazz spend` reads.                                                                                                                                                                                                                                                                                              |
| **Local inference**       | Point `JAZZ_TELEGRAM_PROVIDER=ollama` at a local model: no provider key or per-message model cost. Tools and telemetry keep their own network policy.                                                                                                                                                                                                                                                                                                                                             |
| **Allowlist**             | Only `TELEGRAM_ALLOWED_CHAT_IDS` are answered; everyone else is silently ignored.                                                                                                                                                                                                                                                                                                                                                                                                                 |

### The message flow

```mermaid
sequenceDiagram
    autonumber
    participant TG as Telegram
    participant BR as bridge (Bun)
    participant JZ as jazz run
    participant LLM as Model + tools

    TG->>BR: getUpdates long-poll → message
    BR->>BR: chat id in allowlist?
    BR->>TG: sendChatAction "typing…"
    BR->>JZ: spawn: --json --conversation chat-id
    JZ->>LLM: iterate: reason → call tools → observe
    JZ--)BR: stderr NDJSON: tool_execution_start, subagent_start…
    BR--)TG: edit status bubble (live)
    LLM-->>JZ: final answer
    JZ-->>BR: stdout: one JSON envelope
    BR->>TG: sendMessage (markdown, new message so it notifies)
    BR->>TG: edit bubble → "✅ Done · 7 tools · 12k tokens · $0.03"
```

---

## Discord (shipped)

```bash
cd packages/discord-bot/src
cp .env.example .env     # set DISCORD_BOT_TOKEN + an allowlist + a model key
docker compose up -d --build
```

DM the bot, or `@mention` it in an allowlisted channel. For the account-creation steps
(application, intents, invite URL), see
[Reaching your agent from a chat app](../guides/deploy-a-chat-agent.md); for the full configuration
table and mention-gating details, see
[`packages/discord-bot/README.md`](../../packages/discord-bot/README.md).

When the agent is waiting for your answer or approval, you can reply in the same channel
without mentioning it again, including with `DISCORD_CREATE_THREADS=0`. Only the person
who started that run gets this exception; user, channel, and guild allowlists still apply.
Once the pending prompts are answered, ordinary mention-gating resumes.

Same `jazz run` contract as Telegram. What Discord adds on top:

| Feature                   | How it works                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mention-gating**        | In servers the bot ignores chatter unless mentioned, replied-to, or already in the thread. DMs always respond.                                                                                                                                                                                                                                    |
| **Thread binding**        | An `@mention` in a channel starts a thread; `--conversation` is the thread id so the rest of the room is not the chat.                                                                                                                                                                                                                            |
| **3-second ack**          | Slash commands and buttons are acknowledged before any lookup or run starts, so a slow channel lookup or model list never fails the interaction; anything the clicker needs to know arrives as an ephemeral follow-up.                                                                                                                            |
| **Allowlists**            | Users, channels, and/or guilds. At least one is required.                                                                                                                                                                                                                                                                                         |
| **Any-provider `/model`** | Bare `/model` shows a select menu of the current provider's models; send `/model provider/model` (e.g. `/model openrouter/z-ai/glm-5.3-flash`) as a normal message (not the slash-command menu, which can't take a free-form value) to switch provider outright. Set that provider's API key as an env var on the bot first (see `.env.example`). |

---

## iMessage and WhatsApp (shipped)

```bash
jazz imessage             # hosted line through Photon; no Mac required
jazz imessage --local     # your Apple account; macOS 14+
jazz whatsapp     # links as a device, the way WhatsApp Web does
```

Setup walkthrough: [Reaching your agent from a chat app](../guides/deploy-a-chat-agent.md#imessage-with-a-hosted-line).
Full tables: [`packages/imessage-bot/README.md`](../../packages/imessage-bot/README.md),
[`packages/whatsapp-bot/README.md`](../../packages/whatsapp-bot/README.md).

The local iMessage and WhatsApp bridges use the same `jazz run` contract as Telegram. Photon
uses the same Jazz agent surface behind a hosted iMessage transport.

| Concern              | What changes                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where it runs**    | Local iMessage needs an awake, signed-in Mac. Photon can run anywhere but carries messages through a third party. WhatsApp needs its linked-device process alive.                                                                |
| **No buttons**       | Approvals arrive as numbered options answered by replying `1` or `2`. A reply matching nothing is treated as an ordinary message, so an ignored prompt never swallows the next question.                                         |
| **No live progress** | iMessage cannot edit a sent message: `🤔 Working…`, a "still working" line at 45s and roughly once a minute after, then the answer. No status bubble to update.                                                                  |
| **Stopping a run**   | Send `/stop`. It is answered at once, like `/status`, `/help` and `/new`, rather than waiting behind the run it would stop.                                                                                                      |
| **Formatting**       | WhatsApp gets the model's Markdown in its own dialect (`*bold*`, `_italic_`, `~strike~`, code blocks); Messages gets plain text with the marks dropped.                                                                          |
| **Whose account**    | iMessage answers as _you_, so a chat with yourself needs a trigger word to tell questions from the bridge's own replies. Photon gives the agent a line of its own instead: [`packages/photon-bot/`](../../packages/photon-bot/). |
| **Allow-list shape** | Handles (E.164 or Apple ID) and group rowids for iMessage; numbers and group JIDs for WhatsApp. Both deny-by-default; being allowed to DM never admits you to a group.                                                           |
| **Isolation**        | Per-conversation uid sandboxing is a Linux mechanism the containerised bridges use. On a Mac or a linked device every chat shares one `JAZZ_HOME` and runs as your user.                                                         |
| **Sanctioning**      | WhatsApp publishes no API for personal accounts; the bridge speaks the WhatsApp Web protocol via Baileys. Unusual behaviour can get a number limited or banned. Use a dedicated one if it matters.                               |

**Secrets the agent asks for** (`ask_user_secret`, a PDF password, say) are collected only in a
one-to-one chat with the bot: your next message is the value, it goes to the run over its private
pipe and is never forwarded as a turn, and the agent sees only `[redacted:<name>]`. Telegram deletes
your message once it is read; Discord, WhatsApp and iMessage bots cannot, so the prompt asks you to
delete it. In a group, a server channel or a Photon space the secret is not collected, and the chat
is told to take it to a private chat. See
[Secrets the person types](../security/secrets-and-egress.md#secrets-the-person-types).

---

## Slack, Google Chat

No adapter ships. Here's what changes from the shipped bridges, and it really is just the
edges:

| Concern              | Telegram                          | Discord                                           | Slack                                 | Google Chat            |
| -------------------- | --------------------------------- | ------------------------------------------------- | ------------------------------------- | ---------------------- |
| **Inbound**          | `getUpdates` long-poll or webhook | Gateway websocket                                 | Events API webhook (or Socket Mode)   | Chat app webhook       |
| **Conversation key** | `chat_id`                         | DM channel id, or thread id                       | `channel + thread_ts`                 | `space + thread name`  |
| **Reply formatting** | Markdown / HTML                   | Markdown (close to standard)                      | `mrkdwn` (`*bold*`, no `#` headings)  | app card or plain text |
| **Live progress**    | edit the status message           | edit the status message                           | `chat.update` on a placeholder        | update the card        |
| **Ack deadline**     | none                              | **3 s** for interactions                          | **3 s**: ack, then reply async        | **30 s**               |
| **Authorization**    | chat-id allowlist                 | user / channel / guild allowlist + mention-gating | verify signing secret, then allowlist | verify bearer token    |

Two things to get right, both platform-side:

1. **Ack fast, answer later.** Slack will retry a webhook you don't ack within 3 seconds,
   and an agent run takes longer than that. Ack immediately, run `jazz run` in the
   background, and post the answer as a follow-up. Retries are also why you should
   de-duplicate on the platform's event id: otherwise a slow run gets billed twice.
2. **Translate the markdown.** `jazz run` without `--json` gives you raw markdown
   precisely so you can convert it. Slack's `mrkdwn` in particular is not markdown.

Everything else (memory, tools, approvals, cost) you get from the flags.

---

## Sending yourself a message

A bridge is a bot, and a bot can post without being asked. Once one is running you
have a push channel to your own phone that anything on that machine can use: a
script, a cron job, a long-running agent run, another session on another host, you
at a shell. It does not have to be about the bridge, and it does not have to be
about a deploy.

Each bridge ships a `notify.sh` next to it that takes one argument:

```sh
~/jazz/packages/telegram-bot/src/notify.sh "backup finished, 41 GB, no errors"
~/jazz/packages/telegram-bot/src/notify.sh "$(df -h / | tail -1)"
~/jazz/packages/telegram-bot/src/notify.sh "training run 7 done: val loss 0.312"
~/jazz/packages/discord-bot/src/notify.sh "nightly update rolled back, needs a look"
```

It reads the same `.env` the bridge runs on and posts to the first allowed chat
(`TELEGRAM_ALLOWED_CHAT_IDS`, or `DISCORD_ALLOWED_CHANNEL_IDS`).

What makes it worth reaching for over any other alerting: **no run is started and
no model is called.** It is a single API call, so it costs nothing, needs no
provider key, and works while the agent is busy, wedged, or not running at all ,
which is exactly when you most want to hear from the machine. It also means you can
call it from inside something the agent is doing without recursing into a new run.

Chain it onto anything long:

```sh
./long-job.sh && notify.sh "long-job: done" || notify.sh "long-job: FAILED ($?)"
```

Or hand it to `cron`, where it replaces the usual habit of appending to a logfile
nobody opens. That habit has a real cost: a nightly updater on one box failed for
over two weeks before anyone noticed, because its only output went to
`~/jazz-autoupdate.log`. `auto-update.sh` now calls `notify.sh` instead.

It exits non-zero and explains itself if the credentials are missing, so a caller
can note that without failing whatever it was doing:

```sh
notify.sh "..." || echo "(notify failed)"
```

### Doing it without the script

Useful from a machine that has no checkout, or when the script itself is what is
broken. The shape matters more than the URL:

```sh
ENV=~/jazz/packages/telegram-bot/src/.env
token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV" | tail -1)
chat=$(sed -n 's/^TELEGRAM_ALLOWED_CHAT_IDS=//p' "$ENV" | tail -1 | cut -d, -f1)

curl -sS -o /dev/null -X POST \
  "https://api.telegram.org/bot${token}/sendMessage" \
  --data-urlencode "chat_id=${chat}" \
  --data-urlencode "text=multi-line messages
work fine this way"
```

Three details that are easy to get wrong:

- **Read the token, don't print it.** Assign it to a variable; never `cat` the
  `.env` or `echo` the token. Anything that reaches a terminal reaches shell
  history, CI logs, and whatever is reading over your shoulder.
- **Use `--data-urlencode`, not a JSON body.** It handles newlines and any `&`,
  `#` or quote in the message without escaping, which matters when the text is
  command output or an error string you did not write.
- **Send no `parse_mode`.** Telegram rejects the whole request if the text does not
  parse as the markup you claimed, and piped-in output is exactly where an
  unbalanced `*` or `_` turns up. Plain text always sends.

Telegram caps a message at 4096 characters and rejects anything longer, so pipe
long output through `tail -c 4000` rather than sending it whole.

Discord's equivalent needs a bot token in an `Authorization: Bot …` header and a
JSON body, so escaping is on you, which is the main reason to prefer `notify.sh`.

## Security for chat surfaces

A chat surface accepts input from **other people**. That changes the threat model in a way
worth being blunt about.

```mermaid
flowchart LR
    STRANGER["Message from<br/>a person"] --> AGENT["Agent<br/>(full toolset)"]
    AGENT --> POLICY{"--approval-policy"}
    POLICY -->|read-only| SAFE["Reads and searches only"]
    POLICY -->|low-risk| MILD["+ durable work state,<br/>reminders, sub-agents"]
    POLICY -->|high-risk| DANGER["+ shell, git push,<br/>file deletion<br/><b>on the host</b>"]

    classDef ok fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    classDef warn fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    classDef bad fill:#c1443c,stroke:#7d2b26,color:#ffffff
    class SAFE ok
    class MILD warn
    class DANGER bad
```

- **Always use an allowlist.** Both bridges and Jazz have one; use both.
- **Default to `low-risk`.** At `high-risk`, a message (or a prompt injection inside a web page the agent fetched) can run arbitrary commands on the host. That is the documented behavior of that tier, not a bug.
- **Know what "yolo" costs.** Every bridge's `/mode yolo` is `high-risk` for that conversation, and it is sticky: it survives `/new` and bridge restarts until someone sets it back to safe. Only an operator can turn it on (`TELEGRAM_OPERATOR_IDS`, `DISCORD_OPERATOR_IDS`, `WHATSAPP_OPERATOR_NUMBERS`, `IMESSAGE_OPERATOR_HANDLES`, `PHOTON_OPERATOR_HANDLES`; the iMessage account owner always is one), and the same goes for Telegram's "Always allow". Anyone admitted can turn it back to safe. With no operators configured, nobody can turn approvals off from chat.
- **An approval belongs to whoever asked.** In a group, only the person whose message started a run can approve, reject or answer its prompts; a tap or a typed `1` from anyone else does nothing. Cancelling is theirs too, or an operator's.
- **A run gets an allowlisted environment.** The bridge passes an agent run its PATH, locale and time zone, proxies, the provider keys and endpoints Jazz reads, and Jazz's own switches. The bot token, webhook secret, WhatsApp and Photon credentials, the daemon token, and anything else in the bridge's environment are left out, so an agent that runs `env` cannot hand the bot to whoever asked. A message and an incognito transcript reach the run on stdin, never on the command line, where every account on the host could read them.
- **Deny dangerous tools explicitly.** `tools` is additive, so omitting `execute_command` does not remove it. Put exact names such as `execute_command` in the agent's `deniedTools`; Jazz applies denials after every grant.
- **Treat the history volume as sensitive.** Transcripts are plaintext JSON under `~/.jazz/history/`.
- **Allowlisting is not isolation.** Two people on the same allowlist share a host, and a Jazz agent has `read_file` and `execute_command`, so without an OS boundary either one's agent can read the other's transcripts, memory and stored credentials. Both bridges give each conversation its own uid and Jazz home for exactly this: [Telegram](../../packages/telegram-bot/README.md#per-chat-isolation), [Discord](../../packages/discord-bot/README.md#per-conversation-isolation). It matters most where the allowlist is a **guild**, since that admits everyone in it. Anything you build yourself needs the same, or a one-person allowlist.
- **A container is not a boundary against the host.** Root, `sudo`, and the `docker` group all read a bridge's volume whatever its uids and file modes say: the daemon runs as root, and the docker group is root-equivalent. On a machine other people administer, treat everything the bot has stored as readable by every admin on it.
- **Operations.** `/health` fails (503) when the transport stops working: no successful Telegram poll, no Discord heartbeat acknowledgement, a fatal Discord close code (4004, 4010-4014), or for iMessage, WhatsApp and Photon a dead watcher, socket or stream (set `JAZZ_BRIDGE_HEALTH_PORT`). On SIGTERM a bridge stops taking messages, tells anyone with a run in flight, cancels it and exits. Telegram keeps the messages sent while it restarted. Reconnects back off with jitter, and waiting for your approval does not count against the run's timeout.
- **Cap concurrency.** `JAZZ_BOT_MAX_CONCURRENT_RUNS` (default 4) bounds how many agent runs one bridge has in flight across every chat, and `JAZZ_BOT_MAX_QUEUED_MESSAGES` (default 5) how many messages may wait behind one chat's run.
- **Cap spend.** Use `costKnown` as well as `costUSD`. The bridges pause subsequent requests after an unpriced run; no dollar cap can guarantee the cost of that first unpriced request.

Full model: [Security](../../SECURITY.md).

---

## Related

- [Headless](./headless.md): the contract every bridge uses
- [`packages/telegram-bot/`](../../packages/telegram-bot/): Telegram reference implementation
- [`packages/discord-bot/`](../../packages/discord-bot/): Discord reference implementation
- [`packages/photon-bot/`](../../packages/photon-bot/): hosted iMessage line
- [`packages/imessage-bot/`](../../packages/imessage-bot/): local iMessage through your Mac
- [`packages/whatsapp-bot/`](../../packages/whatsapp-bot/): WhatsApp, as a linked device
- [Local and air-gapped models](../getting-started/local-models.md): keeping inference local and enforcing egress controls

Reminder delivery claims each due item before sending and removes it only after success. Failed
sends retain their delivery state and retry with backoff, including on Discord’s shared turn core.
