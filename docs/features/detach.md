---
description: "Move a chat conversation to your own SSH server, close the laptop, watch and steer it from anywhere, then bring it and its file changes back."
---

# Continue on your server

Start a task in chat, hand it to a server you own, and close the laptop. The server keeps
working. Later, from any machine, you watch it, answer its questions, and bring the
conversation and its file changes back.

## Set up a server once

You need:

- An SSH alias in `~/.ssh/config` that connects with a key, no password prompt, and whose
  host key is already in `known_hosts`.
- A Linux or macOS server (x64 or arm64) with `curl` and `gzip`, and an empty directory for
  Jazz to work in.
- An agent on a cloud provider: OpenAI, Anthropic, Gemini, OpenRouter, xAI, Cerebras,
  DeepSeek, Fireworks, Groq, Mistral, OrcaRouter, or Together AI. Local model servers do not
  travel.

Register the server and check it:

```sh
jazz hosts add nightbox nightbox /home/you/jazz-work
jazz hosts doctor nightbox
```

Jazz installs the Jazz release that matches yours into `~/.local/bin` on the server the
first time you detach. You do not install it by hand.

Your provider key goes into the server's OS keyring. Most headless Linux servers have none,
and the handoff stops with a hint to install libsecret. To keep the key in a private file
(`~/.jazz/secrets.json`, mode 600) instead, register the server with the flag:

```sh
jazz hosts add nightbox nightbox /home/you/jazz-work --allow-file-secrets
```

## Move a conversation

In chat, from the root of a Git repository:

```text
/detach nightbox
```

Jazz asks what to continue doing, then shows what will move: the files, the credential, and
the limits the server works under. Nothing leaves your machine until you confirm.

On the server the agent works under a low-risk approval policy with a $5, 8-hour,
100-iteration cap. Anything riskier than reading and searching, such as writing a file,
pauses for your approval.

After you confirm, the chat closes. The conversation now belongs to the server, and Jazz
refuses to run it locally until you take it back.

## Watch and steer it

```sh
jazz detach attach <handoff-id>
```

Attach replays everything the server has done, then follows it live. When a turn finishes,
type your next message. When the run pauses for approval, answer `y` or `n`. An empty line or
Ctrl+C leaves; the server keeps going, and attaching again picks up where you left off.

| Command                            | Does                                         |
| ---------------------------------- | -------------------------------------------- |
| `jazz detach list`                 | Show every conversation you moved, and where |
| `jazz detach status <handoff-id>`  | Print the current state once                 |
| `jazz detach approve <handoff-id>` | Approve a paused action without attaching    |
| `jazz detach reject <handoff-id>`  | Reject it, and let the run continue          |
| `jazz detach cancel <handoff-id>`  | Stop the current turn                        |

## Take it back

```sh
jazz detach reclaim <handoff-id>
```

The server stops owning the conversation and never runs it again. Jazz applies the server's
file changes to your working tree and restores the conversation, remote turns included.
Continue it with `/resume` in chat.

If a file changed both on your machine and on the server, reclaim writes nothing and lists
the files. Commit or stash your edits and run it again, or let the server's version win:

```sh
jazz detach reclaim <handoff-id> --overwrite
```

## What moves with it

| Moves                                        | Stays on your machine                     |
| -------------------------------------------- | ----------------------------------------- |
| The conversation and its work notes          | Files your `.gitignore` excludes (`.env`) |
| Tracked and untracked files, and Git history | MCP servers and plugins                   |
| The agent, without its keys                  | Long-term memory                          |
| Your skills and the agent's custom persona   | Every credential except the provider key  |
| The agent's provider key                     | Your SSH agent                            |

An agent's custom tools move too, but they run their commands on the server, so the server
needs those commands installed.

## When something goes wrong

- **`unknown` status.** Jazz could not reach the server. The run may still be going; check
  again later.
- **"This host has no OS keyring".** Install libsecret on the server, or re-register it with
  `--allow-file-secrets`.
- **Nothing happens after a server reboot.** The Jazz daemon does not restart on its own:
  `ssh nightbox '~/.local/bin/jazz daemon'`.
- **"Conversation … is remote for host …".** That conversation is on a server. Reclaim it
  first.
- **"A different skill already exists on this host".** Another handoff put a skill with the
  same name but different contents on the server. Rename one of them.

For the credential and isolation model, see [Detach hosts](../security/detach-hosts.md).
