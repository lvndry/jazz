---
description: "Register and check an SSH host before detaching a Jazz conversation."
---

# Detach hosts

This page covers what a detach host can see and do. To set one up and use it, start with
[Continue on your server](../concepts/detach.md).

Register an SSH alias that already resolves through your SSH configuration and a workspace
directory owned by the remote user:

```sh
jazz hosts add nightbox nightbox /home/jazz/work
jazz hosts doctor nightbox
```

The directory must already exist and be writable by the remote account. `doctor` checks the
SSH host identity through your `known_hosts`, confirms the remote operating system and
architecture, checks free disk space, reports the version of `~/.local/bin/jazz` (the binary
detach runs), and checks the default loopback daemon health endpoint. A changed or unknown SSH host key stops the check.
Jazz disables SSH agent and port forwarding for these operations.

After confirmation, Jazz installs the matching published Jazz release into the remote
user's `~/.local/bin` when needed, verifying its release checksum, and checks that it
speaks the detach protocol. The current development checkout cannot be sent as a
source tree; a matching published build is required. Jazz starts a loopback daemon if
one is not healthy. That background process survives the SSH session, but a server
reboot requires a separately configured service or a new daemon start.

```sh
jazz hosts list
jazz hosts remove nightbox
```

Removing a registration does not delete files or credentials on the server. Remote runs use
that server's OS permissions. Create a dedicated account and private Jazz home for the jobs
you plan to detach. The provider key travels over SSH stdin into the server's OS keyring
(libsecret on Linux). A headless server often has no keyring; a handoff to it stops before
the conversation moves and tells you to install libsecret. To accept a mode-`0600`
`$JAZZ_HOME/secrets.json` file instead, register the host with `--allow-file-secrets`:

```sh
jazz hosts add nightbox nightbox /home/jazz/work --allow-file-secrets
```

The daemon reads that key when each detached turn starts, so a key imported or rotated after
the daemon started still applies. Jazz refuses transfer when remote secret storage is
disabled.

The host profile stores an SSH alias and a workspace path, never a password or an SSH private
key. Detached runs do not inherit local SSH agent access, MCP servers, plugins or plugin trust
decisions, long-term memory, or the rest of your local Jazz configuration. Your user skills
(`~/.jazz/skills`) and the agent's custom persona do travel. A skill or persona of the same
name that differs on the server stops the handoff rather than being overwritten. An agent's
custom tools travel with its definition and run their commands on the server, which must
provide them; the confirmation card warns about this.

Remote work continues after you close SSH. If the daemon dies during a run, Jazz marks
the job interrupted and asks for review instead of repeating actions that may already
have happened.

Each detached job has a cost, active time, and iteration cap. Jazz records usage before
parking for approval and subtracts it from the caps when the daemon resumes the job.
Time waiting for an answer does not consume the active time cap. If a cap is exhausted,
the queued answer fails instead of starting another agent segment. Cost enforcement uses
the model's reported usage and available pricing metadata; a provider without priced
usage cannot be bounded by the dollar cap, so use the active time and iteration caps as
independent limits.

## Watching, steering, and taking it back

```sh
jazz detach attach <handoff-id>
jazz detach cancel <handoff-id>
jazz detach reclaim <handoff-id>
```

Attach to watch progress, send replies, and answer approvals. Disconnecting leaves the
server running. Cancel stops the current turn; its last tool call may already have acted.

Reclaim stops further remote execution and downloads the conversation and file changes
for local use. The server retains its workspace and log until you remove them. See
[Remote handoff](../concepts/detach.md) for conflict handling and the full command sequence.
