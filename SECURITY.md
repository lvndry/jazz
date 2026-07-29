# Security Policy

Jazz is an agent that executes real actions on your machine: it reads and writes files, runs
shell commands, makes network requests, and drives external services. This document is both
the vulnerability-reporting policy and the guide to running it safely.

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Scope](#scope)
- [How Jazz protects you](#how-jazz-protects-you)
- [Running Jazz safely](#running-jazz-safely)
- [If something goes wrong](#if-something-goes-wrong)

---

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via
[GitHub Security Advisories](https://github.com/lvndry/jazz/security/advisories/new). If you
cannot use that, email <lvndry@proton.me> with `SECURITY` in the subject.

Please include:

- What the issue is and why it matters
- Steps to reproduce, or a proof of concept
- The Jazz version (`jazz --version`) and your platform
- Any suggested fix, if you have one

You can expect an acknowledgement within a few days. We will keep you informed as we
investigate, and credit you in the advisory unless you prefer otherwise.

## Supported versions

Jazz is pre-1.0 and ships frequently. Fixes land on the latest published version — please
confirm the issue reproduces on the current release (`jazz update`) before reporting.

---

## Scope

Some behavior that looks alarming is deliberate and documented rather than a vulnerability.

**In scope** — please report:

- A gated tool executing without approval, or any way to bypass the approval system
- Privilege escalation past the configured `--approval-policy` / `autoApprove` tier
- The command allowlist matching more than it should (e.g. a prefix-matching bypass)
- Credential or API-key leakage into logs, telemetry, transcripts, or error output
- Command or argument injection reachable from untrusted input
- Anything that lets a remote party act on a host running Jazz without local consent

**Out of scope** — working as documented:

- `--approval-policy high-risk` (or `autoApprove: true`) permitting destructive commands. That tier exists to grant exactly that, and the docs say so.
- A novel way to phrase a shell command that the denylist does not catch. The denylist is defense-in-depth against an accident, [explicitly not a sandbox](#the-command-denylist-is-not-a-sandbox) — approval is the real control.
- An agent acting on instructions embedded in content it fetched, when running at a tier that permits those actions. Prompt injection is real, which is why the tiers exist.
- Plaintext conversation transcripts under `~/.jazz/history/`. Documented; treat that directory as sensitive.
- An MCP server you configured doing something you did not expect. MCP servers are third-party code you chose to run.

If you are unsure which side of that line something falls on, report it — we would rather
triage a non-issue than miss a real one.

---

## How Jazz protects you

**Approval gating is the primary control.** 15 of the built-in tools do not act when the model
calls them; they describe what they would do (including a real diff for edits) and wait for
approval — from you, or from the policy tier on an unattended run. Mechanism and risk tiers:
[Tools & approval](docs/internals/tools-and-approval.md).

**A shell command denylist** blocks 56 patterns before execution — privilege escalation
(`sudo`, `su`), filesystem destruction (`rm -rf /`), remote code execution (`curl … | sh`),
power/runlevel changes (`shutdown`), and reads of `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`.

### The command denylist is not a sandbox

Quoting the implementation directly, because it matters:

> This is a defense-in-depth denylist, not a sandbox. It cannot stop a determined attacker —
> variable expansion, base64 obfuscation, eval, and other indirection paths can route around
> any string matcher.

Its job is catching an *accident* from a confused model. Do not treat it as a boundary against
a hostile one. If you need a real boundary, use [container isolation](#harden-the-host).
Implementation and the documented set of known bypasses:
[`shell-tools.ts`](src/core/agent/tools/shell-tools.ts),
[`shell-tools.security.test.ts`](src/core/agent/tools/shell-tools.security.test.ts).

**Environment sanitization.** Shell commands run with variables matching
`API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH` (case-insensitive), plus everything prefixed
`SSH_`, stripped from the environment. An agent's `envAllowlist` can exempt specific names when
a command genuinely needs one. Implementation:
[`env-utils.ts`](src/core/utils/env-utils.ts).

**Local-only data.** Credentials live in your config; telemetry is JSON on your disk and is
never transmitted. `JAZZ_OFFLINE=1` stops Jazz initiating any outbound request of its own. See
[Airgapped & self-hosted](docs/guide/airgapped.md).

**Audit trail.** Every tool invocation is logged under `~/.jazz/logs/`, with per-run token and
cost records under `~/.jazz/telemetry/`.

---

## Running Jazz safely

### Give each agent the fewest tools it needs

This is the strongest control available, and it is stronger than any policy tier: **an agent
whose toolset omits `execute_command` cannot run shell commands at all**, regardless of
approval settings. Configure the toolset per agent rather than granting everything and relying
on the gate.

### Pick the lowest policy tier that lets the job finish

| Tier | Auto-approves |
| --- | --- |
| unset / `false` | Nothing |
| `read-only` | Reads, search, web requests, `git status`/`log`/`diff` |
| `low-risk` | + `manage_todos`, `spawn_subagent` |
| `high-risk` | + writes, deletes, shell, `git commit`/`push` |

`low-risk` is narrower than it sounds — it adds exactly two tools. Email, calendar, and
Obsidian are skills that shell out via `execute_command` (`high-risk`), so prefer allowlisting
one binary over raising the whole tier:

```json
// ~/.jazz/config.json
{ "autoApprovedCommands": ["himalaya", "khal"] }
```

Matching uses a parsed key (binary + first subcommand), never a raw prefix — `git status` does
not also permit `git status && rm -rf /`. Full tiers: [Tools reference](docs/reference/tools.md).

### Be deliberate on surfaces that accept input from other people

A chat bridge, a public webhook, or a CI job reviewing fork PRs takes input from someone who is
not you. At `high-risk`, a message — or a prompt injection inside a web page the agent fetched
— can run arbitrary commands on that host. Use an allowlist of senders, keep the tier low, and
trim the toolset. See
[Chat platforms → security](docs/surfaces/chat-platforms.md#security-for-chat-surfaces).

### Before approving, ask

- Do I understand what this will do, and is it reversible?
- Am I in the right directory, and are the paths correct?
- For `git push` — the right remote and branch?

### Harden the host

For untrusted work or unattended deployments, isolate rather than trust:

```dockerfile
FROM node:20-alpine
RUN npm install -g jazz-ai
USER node
WORKDIR /home/node
CMD ["jazz"]
```

Also consider a dedicated OS user for running Jazz, and separate service accounts (a bot
GitHub account, a separate mailbox) so a mistake cannot reach your primary identity.

---

## If something goes wrong

1. **Stop the run** — double-Escape interrupts generation and any running tool; otherwise exit the process.
2. **Check what happened** — `~/.jazz/logs/` has every tool invocation with its arguments.
3. **Recover** — `git reflog` finds the pre-mistake state, then `git reset --hard <commit>`. For files, restore from backup or your trash.
4. **Report it** — if the cause was Jazz acting without approval rather than an approval you granted, that is [in scope](#scope).

---

## Related

- [Tools & approval](docs/internals/tools-and-approval.md) — how gating and risk tiers are enforced
- [Tools reference](docs/reference/tools.md) — every tool and its tier
- [Configuration](docs/reference/configuration.md) — `envAllowlist`, `autoApprovedCommands`
- [Airgapped & self-hosted](docs/guide/airgapped.md) — removing outbound network entirely
- **Security questions:** [Discord](https://discord.gg/yBDbS2NZju) · [Discussions](https://github.com/lvndry/jazz/discussions)
