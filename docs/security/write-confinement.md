---
description: "Write confinement fences model-run shell commands and file tools to the working directory, temp and tool caches with macOS Seatbelt or Linux bubblewrap."
---

# Write confinement

Write confinement is an operating-system fence under `execute_command` and the `write_file`,
`edit_file`, `create_pdf` and the `rm`, `mv`, `cp` and `mkdir` tools. With it on, a command can write only inside:

- the session's working directory;
- Jazz's scratch directory (`~/.jazz/workspace`);
- temp directories (`$TMPDIR`, `/tmp`, `/var/tmp`);
- developer tool caches: `~/.cache`, `~/.bun`, `~/.npm`, `~/.pnpm-store`, `~/.yarn`,
  `~/.cargo/registry`, `~/.cargo/git`, and `~/Library/Caches` on macOS.

Everything else on disk stays readable and unwritable. **Reads and the network are not
confined.** The rest of your home directory, including `~/.ssh`, shell startup files and
`~/.jazz` itself, cannot be written by a confined command. Confinement covers file writes only: it
does not stop a command from sending data over the network.

## When it is on

| Surface                                                                              | Default |
| ------------------------------------------------------------------------------------ | ------- |
| Interactive chat with a person at the terminal                                       | off     |
| `jazz run` in a terminal where its questions reach you                               | off     |
| `jazz run` piped, in CI or cron; bridge bots (Telegram, Discord, iMessage, WhatsApp) | on      |
| Peers, webhooks, goals, loops, daemon work                                           | on      |

The rule is whether a person is at the terminal who can type `continue`: when nobody is, the fence
is on. Set `shell.confinement` in your global config to override either way:

```json
{ "shell": { "confinement": "on" } }
```

`off` is the only value that lets commands run unconfined. A project's `.jazz/config.json` can
turn confinement on but not off; Jazz ignores a project `off` and says so.

## What Jazz needs from the machine

| Platform | Backend                 | Needs                                                 |
| -------- | ----------------------- | ----------------------------------------------------- |
| macOS    | `/usr/bin/sandbox-exec` | Nothing to install.                                   |
| Linux    | `bwrap` (bubblewrap)    | `apt install bubblewrap` and user namespaces.         |
| Windows  | none                    | Run Jazz in WSL, or set `shell.confinement` to `off`. |

Jazz runs a real command under the backend once per process and reports what held:

- `full`: a write outside the roots was refused and a write inside succeeded.
- `partial`: confinement holds with a named gap. On Linux hosts whose kernel refuses a private
  `/dev`, device nodes under `/dev` stay writable.
- `none`: no backend, or one that did not refuse the outside write.

When confinement is on and the level is `none`, commands are **refused**, not run unconfined. The
message says why and what to install, or that `shell.confinement: "off"` is the way to opt out.
The level appears in `/info`.

## When a command is denied

A write outside the roots fails with `Operation not permitted` (macOS) or `Read-only file system`
(Linux). Jazz recognizes it only when the command exited non-zero, a stderr line ends in one of
those texts, and the path on that line lies outside the roots. The result then carries
`confinement.deniedPath` and tells the model it may retry that exact command once with `escalate`
set to a reason.

The retry goes through the approval prompt, which shows the denied path and the reason and is
asked even when a policy would auto-approve the command. Approving runs that one call
unconfined. Nobody is asked on a surface with no one to answer, so the model is told to write
inside the roots instead. A command can be escalated once; a command that was never denied cannot
be escalated.

The file tools do not escalate: a path outside the roots is refused with the roots named.

## Limits

- The fence covers writes, not reads or the network.
- `manage_scratchpad` writes only under Jazz's own scratch directory, which is a writable root, so it needs no separate check.
- Commands the daemon runs from a `wait_for` job and the operator's `!` escape run unconfined.
- `sandbox-exec` is deprecated by Apple but ships on every supported macOS.
- Linux support needs `bwrap` and unprivileged user namespaces; hosts without them report `none`.
- Seatbelt and bwrap enforce at the kernel, so a command cannot lift the fence from inside; a
  process that is not a child of the command (a daemon you started earlier) is not fenced.
