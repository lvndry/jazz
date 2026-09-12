# iMessage bridge (`jazz imessage --local`)

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
- [`imsg`](https://github.com/openclaw/imsg) — the MIT CLI this bridge drives.
  **You do not have to install it first**: on the first run the bridge notices
  it is missing and offers to install it for you.

  ```text
  `imsg` is not installed.

  The iMessage bridge reads Messages through `imsg`, an open-source (MIT) CLI:
    https://github.com/openclaw/imsg

  It can be installed now with `brew install steipete/tap/imsg`.

  Install it? [Y/n]
  ```

  It only ever asks when there is a terminal attached — started as a
  LaunchAgent, it prints the command and exits rather than reaching out to a
  package manager unattended. It also never offers an install for a *permission*
  problem, since reinstalling cannot grant Full Disk Access.

- **Full Disk Access**, so it can read your Messages. macOS keeps messages in a
  protected database and this is the only permission that opens it; the bridge
  points you at the right settings page on first run.

  The grant names whatever macOS holds **responsible** for the process: your
  terminal when you run `jazz imessage` in one, the Jazz binary itself under the
  background service. Adding the binary to the list while running from a
  terminal does nothing, so the bridge names whichever one actually applies.

  The service is the one worth granting: a terminal grant covers every command
  you ever run there, the service grants only this bridge. Step 3 sets that up.

- **Automation → Messages** for the same process, granted the first time it
  sends. macOS prompts once.
- A model backend: an API key for a cloud provider, or a local
  [Ollama](https://ollama.com) with a tool-capable model pulled.

Only `imsg`'s standard capability tier is used (`chats`, `watch`, `send`).
Typing indicators, editing, unsending and tapback-by-GUID are bridge-tier
features that require disabling SIP — this bridge does not ask that of your
machine and does not use them.

## Quick start

```bash
jazz imessage --local
```

That is the whole of it. The first run walks through what it needs — installing
[`imsg`](https://github.com/openclaw/imsg), granting Full Disk Access, and
whether to keep running in the background — and nothing is asked before you ask
for iMessage, which is why none of it happens when you install Jazz.

By default it answers as its own seeded assistant. To use an agent you already
have, name it — it is copied into the bridge's home, so the original keeps its
name and stays yours:

```bash
jazz imessage --local --agent nostra
```

With nothing configured it answers only you: text **yourself** `jazz <question>`
from any of your devices. To let other people in, set their numbers:

```bash
IMESSAGE_ALLOWED_HANDLES="+15551234567,friend@icloud.com" jazz imessage
```

Once it offers to run in the background and you accept, it starts at login and
restarts itself if it dies.

```bash
jazz imessage status   # installed? running?
jazz imessage logs     # follow it
jazz imessage stop     # stop it
```

Granting Full Disk Access to the background service rather than to your terminal
is worth doing. macOS attributes the access to whatever started the process, so
granting it from a terminal covers every command you run there, while the
service grants only Jazz.

From a checkout without an installed binary, `bun packages/imessage-bot/src/main.ts`
is the same thing.

## Configuration

| Variable                          | Default             | What it does                                                                                                          |
| --------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IMESSAGE_ALLOWED_HANDLES`        | _(required)_        | Comma-separated phone numbers (E.164) or Apple IDs allowed to DM the agent. Punctuation and case are normalised.       |
| `IMESSAGE_ALLOWED_GROUP_CHAT_IDS` | _(none)_            | Comma-separated `chat.db` rowids of group chats to answer in. Being allowed to DM does **not** admit you in a group.   |
| `IMESSAGE_SELF_TRIGGER`           | _(none)_            | Prefix that makes a message you send yourself a question for the agent, e.g. `jazz`. Off by default, since the bridge must otherwise ignore its own replies. |
| `IMSG_BIN`                        | `imsg`              | Path to the `imsg` binary.                                                                                            |
| `JAZZ_BIN`                        | `jazz`              | Path to the Jazz binary.                                                                                              |
| `JAZZ_HOME`                       | `~/.jazz-imessage`  | Data directory: agents, conversations, reminders, usage.                                                              |
| `JAZZ_IMESSAGE_AGENT`             | `imessage`          | Seed agent every per-chat agent is cloned from. `--agent` sets this and copies the agent in. |
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
| `/status`                | Model, persona, mode, timezone, today's usage                       |
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
