# Photon bridge (`jazz imessage`)

Chat with a [Jazz](../../README.md) agent on an iMessage line **of its own**,
rather than on your Apple account.

```text
iMessage  ◀──(Photon hosted line)──▶  spectrum-ts  ──▶  bridge  ──jazz run --json──▶  OpenAI / Ollama / …
```

## How this one is different

Every other bridge borrows an account you already own. `jazz imessage` answers
as *you*, which is why it needs a trigger word: iMessage marks everything you
send as yours, including the bridge's own replies, so a chat with yourself has
to be told which lines are questions.

Photon assigns the agent its own line. You text it like a person - a real
thread, no trigger word, no messaging yourself. It also runs anywhere: the Apple
side is Photon's problem, so this needs no Mac, no Full Disk Access and no
LaunchAgent.

The trade is that it is a hosted third party. Your messages pass through
Photon's infrastructure, which the local `jazz imessage` bridge avoids entirely.

## Requirements

- A Photon project: sign up at [app.photon.codes](https://app.photon.codes) and
  copy the project id and secret from its Settings page.
- A model backend: an API key for a cloud provider, or a local
  [Ollama](https://ollama.com) with a tool-capable model pulled.

On Photon's free shared-line pool the agent **cannot open a conversation** -
the other person has to text it first - and different recipients may see
different sending numbers. A dedicated number is a paid tier.

## Quick start

```bash
jazz imessage
```

The first run asks for the project id and secret and saves them to
`photon-credentials.json` (mode 0600) under its home, so it only asks once.
`PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET` skip the question, which is what
you want on a server, where the bridge refuses to start rather than ask a
terminal that is not there.

It then asks whose messages the agent should answer and remembers
the answer in `photon-allowed.json` under its home. To answer as an agent you
already have rather than a fresh assistant:

```bash
jazz imessage --agent nostra
```

From a checkout without an installed binary, `bun packages/photon-bot/src/main.ts`
is the same thing.

## Configuration

| Variable                     | Default                | What it does                                                                                   |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `PHOTON_PROJECT_ID`          | _(asked on first run)_ | Project id from app.photon.codes.                                                              |
| `PHOTON_PROJECT_SECRET`      | _(asked on first run)_ | Project secret. Anything holding it can send as your line; saved 0600.                         |
| `PHOTON_ALLOWED_HANDLES`     | _(asked on first run)_ | Comma-separated handles allowed to write to the agent. Punctuation and case are normalised.    |
| `JAZZ_HOME`                  | `~/.jazz-photon`       | Data directory: agents, conversations, reminders, usage.                                       |
| `JAZZ_PHOTON_AGENT`          | `photon`               | Seed agent every per-chat agent is cloned from. `--agent` sets this and copies the agent in.   |
| `JAZZ_APPROVAL_POLICY`       | `low-risk`             | Tier above which tools stop and ask.                                                           |
| `JAZZ_AUTO_APPROVE_TOOLS`    | _(none)_               | Tool names that never prompt, whatever the policy.                                             |
| `JAZZ_RUN_TIMEOUT_MS`        | `300000`               | Per-turn timeout.                                                                              |
| `JAZZ_DAILY_COST_CAP_USD`    | `0` (off)              | Spend ceiling across all chats per day.                                                        |
| `JAZZ_PHOTON_SHOW_REASONING` | on                     | Send the run's reasoning under the answer.                                                     |

## Attachments

Photos, PDFs and voice notes work in both directions. Inbound media arrives as
metadata plus a reader rather than as a file - unlike the local bridge, where an
iMessage attachment is already on disk - so the bytes are fetched and written
under `ph-media/` in the bridge's home, and the agent is handed the path. What it
can *read* depends on the model: images and PDFs almost anywhere, audio and video
only where the model accepts them.

## Security

The allow-list is the whole security model, and it is deny-by-default: a message
from an unlisted handle is logged and never answered, because replying would
confirm to a stranger that something automated reads this line.

Unlike the containerised bridges there is no per-conversation uid sandboxing -
every chat shares one `JAZZ_HOME` and runs as your user.

**Groups are not yet distinguished from direct messages.** Every other bridge
refuses to speak in a group just because one member is allowed; that rule needs
the space's `dm`/`group` flag, which `spectrum-ts@12.8.0` exposes only behind an
index signature typed for actions. Until that is confirmed against a live line,
treat an allow-listed handle as able to reach the agent from a group too.
