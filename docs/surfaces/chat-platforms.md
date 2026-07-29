# Chat platforms — Telegram, Slack, Discord, your own app

**Reader job:** put a real tool-using agent into a chat thread.

A Jazz agent in a chat window isn't a chatbot with your logo on it. It's the same agent
that reads your filesystem, runs git, searches the web, and spawns sub-agents — reachable
from your phone.

| Platform | Status | Where |
| --- | --- | --- |
| **Telegram** | ✅ Deployable reference bridge | [`integrations/telegram-bot/`](../../integrations/telegram-bot/) |
| **Slack** | 🔧 Bring your own bridge | pattern below |
| **Google Chat** | 🔧 Bring your own bridge | pattern below |
| **Discord** | 🔧 Bring your own bridge | pattern below |
| **Your own app** | 🔧 Bring your own bridge | pattern below |

**Be clear on what ships.** Telegram is a complete, production-deployed service with a
Dockerfile, per-user model switching, reminders, and live progress. The others do not ship
an adapter. What they share is the contract — and the transport-specific part of a bridge
is small enough that copying the Telegram one and swapping the transport is the intended
path, not a workaround.

---

## The bridge pattern

Every chat bridge is the same three responsibilities. Only the middle one is
platform-specific.

```mermaid
flowchart TB
    subgraph platform["Platform-specific (~100 lines)"]
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
dispatch, approval logic, or cost tracking — `--conversation` and `--approval-policy`
cover those. See [Headless](./headless.md) for the contract in full.

---

## Telegram (shipped)

```bash
cd integrations/telegram-bot
cp .env.example .env     # set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_IDS + a model key
docker compose up -d --build
```

That's a working agent in your DMs. Full setup, configuration table, and security notes:
[`integrations/telegram-bot/README.md`](../../integrations/telegram-bot/README.md).

What the bridge demonstrates — worth reading before you write your own:

| Feature | How it works |
| --- | --- |
| **Per-user agents** | Each chat gets `tg_<chat_id>.json`, cloned from a template on first contact. `/model` and `/persona` change only that user's experience. |
| **Per-chat memory** | `--conversation <chat_id>`. The bridge itself is stateless. |
| **Live progress** | `--events` NDJSON on stderr drives a status bubble that updates with thinking, tool calls, and sub-agents, then closes with a `✅ Done · tools · tokens · $cost` summary. |
| **Cancellation** | A ⏹ button kills the child process mid-run. |
| **Reminders** | `/remind 30m …`, persisted to disk so they survive restarts and fire late if the bridge was down. |
| **Spend cap** | `JAZZ_DAILY_COST_CAP_USD` — the envelope's `costUSD` is accumulated per day. |
| **Local-only mode** | Point `JAZZ_TELEGRAM_PROVIDER=ollama` at a local model: no keys, no cloud, no per-message cost. |
| **Allowlist** | Only `TELEGRAM_ALLOWED_CHAT_IDS` are answered; everyone else is silently ignored. |

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

## Slack, Google Chat, Discord

No adapter ships. Here's what changes from the Telegram bridge, and it really is just the
edges:

| Concern | Telegram | Slack | Google Chat | Discord |
| --- | --- | --- | --- | --- |
| **Inbound** | `getUpdates` long-poll or webhook | Events API webhook (or Socket Mode) | Chat app webhook | Gateway websocket or interactions webhook |
| **Conversation key** | `chat_id` | `channel + thread_ts` | `space + thread name` | `channel_id` (or thread id) |
| **Reply formatting** | Markdown / HTML | `mrkdwn` (`*bold*`, no `#` headings) | app card or plain text | Markdown (close to standard) + embeds |
| **Live progress** | edit the status message | `chat.update` on a placeholder | update the card | edit the deferred reply |
| **Ack deadline** | none | **3 s** — ack, then reply async | **30 s** | **3 s** — defer, then follow up |
| **Authorization** | chat-id allowlist | verify signing secret, then allowlist | verify bearer token | verify signature |

Two things to get right, both platform-side:

1. **Ack fast, answer later.** Slack and Discord will retry a webhook you don't ack within
   3 seconds, and an agent run takes longer than that. Ack immediately, run `jazz run` in
   the background, and post the answer as a follow-up. Retries are also why you should
   de-duplicate on the platform's event id — otherwise a slow run gets billed twice.
2. **Translate the markdown.** `jazz run` without `--json` gives you raw markdown
   precisely so you can convert it. Slack's `mrkdwn` in particular is not markdown.

Everything else — memory, tools, approvals, cost — you get from the flags.

---

## Security for chat surfaces

A chat surface accepts input from **other people**. That changes the threat model in a way
worth being blunt about.

```mermaid
flowchart LR
    STRANGER["Message from<br/>a person"] --> AGENT["Agent<br/>(full toolset)"]
    AGENT --> POLICY{"--approval-policy"}
    POLICY -->|read-only| SAFE["Reads and searches only"]
    POLICY -->|low-risk| MILD["+ todos, sub-agents"]
    POLICY -->|high-risk| DANGER["+ shell, git push,<br/>file deletion<br/><b>on the host</b>"]

    classDef ok fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    classDef warn fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    classDef bad fill:#c1443c,stroke:#7d2b26,color:#ffffff
    class SAFE ok
    class MILD warn
    class DANGER bad
```

- **Always use an allowlist.** Both bridges and Jazz have one; use both.
- **Default to `low-risk`.** At `high-risk`, a message — or a prompt injection inside a web page the agent fetched — can run arbitrary commands on the host. That is the documented behavior of that tier, not a bug.
- **Trim the toolset.** An agent config that doesn't include `execute_command` cannot run shell commands regardless of policy. This is the strongest control available.
- **Treat the history volume as sensitive.** Transcripts are plaintext JSON under `~/.jazz/history/`.
- **Cap spend.** Use the envelope's `costUSD` to enforce a daily ceiling.

Full model: [Security](../../SECURITY.md).

---

## Related

- [Headless](./headless.md) — the contract every bridge uses
- [`integrations/telegram-bot/`](../../integrations/telegram-bot/) — the reference implementation
- [Airgapped & self-hosted](../guide/airgapped.md) — running a bridge with no cloud provider
