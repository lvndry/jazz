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

- **Full Disk Access** for whatever launches the bridge. System Settings →
  Privacy & Security → Full Disk Access. Without it the bridge exits at startup
  saying so.

  It needs this because Apple publishes no API for *receiving* iMessages — the
  AppleScript handler that once existed is gone, so the row in
  `~/Library/Messages/chat.db` is the only record that a message arrived. That
  file sits behind macOS's all-files privacy class and Apple offers no narrower
  "read Messages" grant, which is why the permission is so broad. Sending needs
  none of it; that is the separate Automation grant below.

  macOS attributes the access to the *responsible* process, so granting it from
  a terminal grants it to the terminal — and thereby to every command you run
  there. For anything you intend to leave running, use the LaunchAgent below and
  grant the binary in `ProgramArguments` instead, so the grant is scoped to the
  bridge.
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

Have that person text you: `🤔 Working…`, then the answer.

**Testing it by yourself.** Messages you type are marked as coming from you —
including in a chat with yourself — and so are the bridge's own replies, which
is why it ignores them by default. Set a trigger word to reach it alone:

```bash
IMESSAGE_SELF_TRIGGER=jazz \
OPENAI_API_KEY=sk-… \
bun packages/imessage-bot/src/bridge.ts
```

Then text **yourself** `jazz what's on my calendar tomorrow?` from any of your
devices. Only messages starting with the trigger are picked up, the trigger is
stripped before the agent sees it, and the bridge recognises its own replies, so
it cannot end up answering itself.

**3. Keep it running.** Once it answers, it offers to install itself as a
background service and hands over to it — so it survives closing the terminal
and comes back at login.

That also narrows the Full Disk Access grant. Started from a terminal, macOS
holds the *terminal* responsible, so granting it there gives every command you
ever run in that window access to every file on the machine. Under launchd this
binary is responsible, and the grant covers the bridge alone.

```bash
tail -f ~/.jazz-imessage/bridge.log                        # follow it
launchctl bootout gui/$(id -u)/ai.lysk.jazz.imessage       # stop it
launchctl kickstart -k gui/$(id -u)/ai.lysk.jazz.imessage  # restart it
```

## Configuration

| Variable                          | Default             | What it does                                                                                                          |
| --------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IMESSAGE_ALLOWED_HANDLES`        | _(required)_        | Comma-separated phone numbers (E.164) or Apple IDs allowed to DM the agent. Punctuation and case are normalised.       |
| `IMESSAGE_ALLOWED_GROUP_CHAT_IDS` | _(none)_            | Comma-separated `chat.db` rowids of group chats to answer in. Being allowed to DM does **not** admit you in a group.   |
| `IMESSAGE_SELF_TRIGGER`           | _(none)_            | Prefix that makes a message you send yourself a question for the agent, e.g. `jazz`. Off by default, since the bridge must otherwise ignore its own replies. |
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
