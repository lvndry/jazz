# iMessage bridge

Chat with a [Jazz](../../README.md) agent from Messages. Every text you send
runs the agent once and comes back as a reply — with per-chat memory,
per-chat model and persona, reminders, and attachments read straight off disk.

```text
Messages.app  ◀──(imsg watch / imsg send)──▶  bridge  ──jazz run --json──▶  OpenAI / Ollama / …
```

## How this one is different

The Telegram and Discord bridges run in a container on a server. This one
cannot: iMessage exists only on a Mac signed into an Apple account, so the
bridge is a process on **your Mac**, and that Mac has to be awake and signed in
for the agent to answer.

Two consequences show up in the chat itself:

- **No live progress.** iMessage cannot edit a sent message, so instead of a
  bubble that updates as the agent works, you get a `🤔 Working…` message, then
  the answer. A run that goes past 45 seconds sends one short "still working"
  line, and roughly one a minute after that.
- **Approvals are numbered replies.** There are no buttons, so when a tool needs
  a human the bridge sends the options numbered and you reply `1` or `2`. A
  reply that matches nothing is treated as an ordinary message and goes to the
  agent, so a prompt you ignore never swallows your next question.

## Requirements

- A Mac running **macOS 14 or newer**, signed into iMessage.
- [`imsg`](https://github.com/openclaw/imsg) — the CLI this bridge drives:

  ```bash
  brew install steipete/tap/imsg
  ```

- **Full Disk Access** for whatever launches the bridge (your terminal, or the
  LaunchAgent below). System Settings → Privacy & Security → Full Disk Access.
  Without it `chat.db` cannot be read and the bridge exits at startup saying so.
- **Automation → Messages** for the same process, granted the first time it
  sends. macOS prompts once.
- A model backend: an API key for a cloud provider, or a local
  [Ollama](https://ollama.com) with a tool-capable model pulled.

Only `imsg`'s standard capability tier is used (`chats`, `watch`, `send`).
Typing indicators, editing, unsending and tapback-by-GUID are bridge-tier
features that require disabling SIP — this bridge does not ask that of your
machine and does not use them.

## Quick start

**1. Find your own handle.** The allow-list is matched against the handle
iMessage reports, which is a phone number in E.164 or an Apple ID:

```bash
imsg chats --limit 20 --json | jq -s '.[] | {id, contact_name, identifier, is_group}'
```

**2. Run it.** The allow-list is mandatory — this bridge answers on a phone
number anyone can text, so it refuses to start without one:

```bash
IMESSAGE_ALLOWED_HANDLES="+15551234567" \
OPENAI_API_KEY=sk-… \
bun packages/imessage-bot/src/bridge.ts
```

Text yourself from another device: `🤔 Working…`, then the answer.

**3. Keep it running.** A LaunchAgent at
`~/Library/LaunchAgents/ai.lysk.jazz.imessage.plist` survives logout and
restarts; grant Full Disk Access to `/opt/homebrew/bin/bun` (or whatever
`ProgramArguments[0]` is) rather than to Terminal.

## Configuration

| Variable                          | Default             | What it does                                                                                                          |
| --------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IMESSAGE_ALLOWED_HANDLES`        | _(required)_        | Comma-separated phone numbers (E.164) or Apple IDs allowed to DM the agent. Punctuation and case are normalised.       |
| `IMESSAGE_ALLOWED_GROUP_CHAT_IDS` | _(none)_            | Comma-separated `chat.db` rowids of group chats to answer in. Being allowed to DM does **not** admit you in a group.   |
| `IMSG_BIN`                        | `imsg`              | Path to the `imsg` binary.                                                                                            |
| `JAZZ_BIN`                        | `jazz`              | Path to the Jazz binary.                                                                                              |
| `JAZZ_HOME`                       | `~/.jazz-imessage`  | Data directory: agents, conversations, reminders, usage.                                                              |
| `JAZZ_IMESSAGE_AGENT`             | `imessage`          | Seed agent every per-chat agent is cloned from.                                                                       |
| `JAZZ_APPROVAL_POLICY`            | `low-risk`          | Tier above which tools stop and ask.                                                                                  |
| `JAZZ_AUTO_APPROVE_TOOLS`         | _(none)_            | Tool names that never prompt, whatever the policy.                                                                    |
| `JAZZ_RUN_TIMEOUT_MS`             | `300000`            | Per-turn timeout.                                                                                                     |
| `JAZZ_DAILY_COST_CAP_USD`         | `0` (off)           | Spend ceiling across all chats per day.                                                                               |
| `JAZZ_IMESSAGE_SHOW_REASONING`    | off                 | Send the run's reasoning under the answer. Off by default — on iMessage it is extra notifications, not a folded quote. |

## Commands

| Command                  | What it does                                                        |
| ------------------------ | ------------------------------------------------------------------- |
| _(any message)_          | Answered by your agent                                              |
| `/new` (`/reset`)        | Fresh conversation; keeps model and persona                         |
| `/model provider/model`  | Switch this chat's model, e.g. `/model anthropic/claude-sonnet-5`   |
| `/persona name`          | Switch this chat's persona; bare `/persona` lists them              |
| `/mode safe\|yolo`       | Whether risky tools stop to ask. Sticky per chat; `/new` keeps it.  |
| `/tz Europe/Paris`       | Timezone reminders resolve in                                       |
| `/status`                | Model, persona, mode, timezone, today's usage, uptime               |
| `/help`                  | The list above                                                      |

A message starting with `/` that is not one of these is passed to the agent
unchanged, so a sentence beginning with a slash still gets an answer.

## Attachments

Photos, PDFs, voice notes and video sent to the chat reach the agent as file
paths — Jazz ingests media by path, and an iMessage attachment is already a
local file, so nothing is downloaded. Whether the agent can *read* one depends
on the model: images and PDFs work almost everywhere, audio and video need a
model that accepts them.

## Security

The allow-list is the whole security model, and it is deny-by-default:

- A message from an unlisted handle is logged and **never answered** — replying
  would confirm to a stranger that something automated reads this number.
- A group is admitted by its own rowid, never because a member is allowed.
  Everything the agent says in a group is read by everyone in it.
- Per-conversation uid sandboxing (what the containerised bridges use) is a
  Linux mechanism and is inactive here; every chat shares one `JAZZ_HOME` and
  runs as your user. Treat `/mode yolo` accordingly.
