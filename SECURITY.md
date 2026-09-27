# Security Policy

Jazz is an agent that executes real actions on your machine. It reads and writes files, runs
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

Jazz is pre-1.0 and ships frequently. Fixes land on the latest published version: please
confirm the issue reproduces on the current release (`jazz update`) before reporting.

---

## Scope

Some behavior that looks alarming is deliberate and documented rather than a vulnerability.

**In scope**: please report:

- A gated tool executing without approval, or any way to bypass the approval system
- Privilege escalation past the configured `--approval-policy` / `autoApprove` tier
- The command allowlist matching more than it should (e.g. a prefix-matching bypass)
- Credential or API-key leakage into logs, telemetry, transcripts, or error output
- Command or argument injection reachable from untrusted input
- Anything that lets a remote party act on a host running Jazz without local consent

**Out of scope**: working as documented:

- `--approval-policy high-risk` (or `autoApprove: true`) permitting destructive commands. That tier exists to grant exactly that, and the docs say so.
- A novel way to phrase a shell command that the denylist does not catch. The denylist is defense-in-depth against an accident, [explicitly not a sandbox](#the-command-denylist-is-not-a-sandbox): approval is the real control.
- An agent acting on instructions embedded in content it fetched, when running at a tier that permits those actions. Prompt injection is real, which is why the tiers exist.
- Plaintext conversation transcripts under `~/.jazz/history/`. Documented; treat that directory as sensitive.
- An MCP server you configured doing something you did not expect. MCP servers are third-party code you chose to run.
- A trusted Jazz plugin doing something outside its manifest declarations. Plugins are executable
  in-process code, and those declarations are consent disclosures rather than a sandbox.
- An explicitly trusted command-risk plugin making a documented probabilistic judgment you
  disagree with, provided Jazz still enforces the hook's declared scope, validation, consent, and
  failure behavior. A bypass of those host controls is a security issue.

If you are unsure which side of that line something falls on, report it: we would rather
triage a non-issue than miss a real one.

---

## How Jazz protects you

**Approval gating is the primary control.** 23 of the 51 built-in agent-facing tools are gated.
11 of them come in approval pairs: they do not act when the model calls them; they describe
what they would do (including a real diff for edits) and wait for approval, from you or from
the policy tier on an unattended run. The other 12 are plain tools above `read-only`, which the
executor holds until the same approval. Counts: [tool inventory](docs/tools/index.md). Mechanism and risk tiers:
[Tools & approval](docs/maintainers/tool-lifecycle.md).

**A shell command denylist** blocks 56 patterns before execution: privilege escalation
(`sudo`, `su`), filesystem destruction (`rm -rf /`), remote code execution (`curl … | sh`),
power/runlevel changes (`shutdown`), and reads of `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`.

### The command denylist is not a sandbox

Quoting the implementation directly, because it matters:

> This is a defense-in-depth denylist, not a sandbox. It cannot stop a determined attacker ,
> variable expansion, base64 obfuscation, eval, and other indirection paths can route around
> any string matcher.

Its job is catching an _accident_ from a confused model. Do not treat it as a boundary against
a hostile one. If you need a real boundary, use [container isolation](#harden-the-host).
Implementation and the documented set of known bypasses:
[`shell.ts`](packages/core/src/agent/tools/shell.ts),
[`shell.security.test.ts`](packages/core/src/agent/tools/shell.security.test.ts).

**Environment sanitization.** Shell commands run with variables matching
`API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH` (case-insensitive), plus everything prefixed
`SSH_`, stripped from the environment. An agent's `envAllowlist` can exempt specific names when
a command genuinely needs one. Implementation:
[`env.ts`](packages/core/src/utils/env.ts).

**Local-first data.** Credentials resolve from the environment, OS keyring, or local config.
Telemetry is recorded locally by default and is exported only when you configure an OTLP endpoint.
`JAZZ_OFFLINE=1` skips Jazz's update, public model-catalog, and library requests; it
does not block inference, tools, MCP, or telemetry export. See
[Local and air-gapped models](docs/getting-started/local-models.md).

**Audit trail.** Tool activity is recorded under `~/.jazz/logs/`, with per-run token and
cost records under `~/.jazz/telemetry/`. Routine operational logs contain tool IDs,
outcomes, and durations rather than command text, arguments, results, or error messages.
The local tool audit record keeps a bounded, redacted argument shape. Credential-bearing
fields in structured metadata (including nested headers) are replaced with `<redacted>`
before a log is written. OTLP export is explicit and uses a private, bounded local outbox
for pending traces and logs. Local records can still contain sensitive non-secret context;
protect `~/.jazz` and send OTLP only to an approved destination.

### Plugins are trusted code

Jazz plugins run inside the Jazz process with the full authority of your OS user. Installing a
plugin only verifies and stores its exact bytes; it does not trust, consent to, or enable them.
Only a local interactive terminal can grant code-digest trust and data-egress consent, and
enablement is scoped to one agent. Inspect the digest, hooks, destinations, data classes, and
secrets before granting either. Disable or remove a plugin and restart long-lived Jazz processes
to evict code that was already imported. See [Plugins](docs/configure/plugins.md).

Before either the plugin or the built-in classifier runs, Jazz marks a command `high-risk` when it
is malformed or contains substitution, a file redirection, or a command name built from a
variable. That check reads syntax only; judging what a given program does is left to the
classifier or plugin. No classifier verdict can lower those. See
[Approvals](docs/security/approvals.md#shell-commands-are-classified-individually).

`classify.command-risk` is a policy hook, not a passive advisory. For an `execute_command` call whose
declared risk is `unknown`, its `read-only` or `low-risk` result can make the active policy skip an
approval prompt. Jazz sends the hook only the bounded command string, after the operator has
consented to that data class and destination. Statically rated tools, tool-set reachability,
explicit allowlists, the active tier, and the shell denylist remain host-enforced. Missing, invalid,
timed-out, or unavailable plugin classification falls back to Jazz's built-in classifier and then
to `high-risk`; failure never lowers risk.

---

## Running Jazz safely

### Give each agent the fewest tools it needs

This is the strongest control available, and it is stronger than any policy tier: **an agent
whose toolset omits `execute_command` cannot run shell commands at all**, regardless of
approval settings. Configure the toolset per agent rather than granting everything and relying
on the gate.

### Pick the lowest policy tier that lets the job finish

| Tier            | Auto-approves                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| unset / `false` | **Nothing.** Every gated call asks, or is declined when nobody can answer                                          |
| `read-only`     | Reads, search, web requests, the agent's own todos/work state/scratchpad, subagents, shell classified inspect-only |
| `low-risk`      | + memory writes, reminders, triggers, compositions, shell classified low-risk                                      |
| `high-risk`     | + writes, deletes, shell, unresolved `unknown` tools                                                               |

Leaving the tier unset is the safe default for unattended work because it grants nothing: a
workflow without `autoApprove` and `jazz run` without `--approval-policy` decline every gated
call. Interactive chat, where you are there to answer, starts in safe mode, which is the
`low-risk` tier: only high-risk calls ask. An `autoApprove` value Jazz does not recognize is an error,
never a tier. Opting into `high-risk` is always explicit: see
[Running fully unattended](docs/security/approvals.md#running-fully-unattended-yolo).

Every tool above `read-only` is gated, including plain tools without a proposal half
(`create_pdf`, custom command tools, a non-`GET` `http_request`). An approval request is honored
only from the tool registered to make it, so a tool (or an MCP server) cannot forge one to run
another tool's execute half.

`low-risk` is narrower than it sounds. It adds three tools. Email, calendar, and
Obsidian are skills that shell out via `execute_command` (`unknown`), so prefer allowlisting
one binary over raising the whole tier:

```json
// ~/.jazz/config.json
{ "autoApprovedCommands": ["himalaya", "khal"] }
```

Matching uses a key parsed the way the shell reads the command (the binary, plus the next word
when it is not a flag), never a raw prefix. A command with control operators (`&&`, `||`, `;`,
`|`, `&`), command or process substitution, redirection, or a leading `NAME=value` assignment
has no key and always asks: `git status` does not also permit `git status && rm -rf /`,
`git status $(rm x)`, `git status > ~/.bashrc`, or `PAGER=x git status`. Wrappers such as
`sudo` stay in the key. Full rules: [Approvals](docs/security/approvals.md#narrowing-without-raising-the-policy).

### Be deliberate on surfaces that accept input from other people

A chat bridge, a public webhook, or a CI job reviewing fork PRs takes input from someone who is
not you. At `high-risk`, a message, or a prompt injection inside a web page the agent fetched
, can run arbitrary commands on that host. Use an allowlist of senders, keep the tier low, and
trim the toolset. See
[Chat platforms → security](docs/surfaces/chat.md#security-for-chat-surfaces).

Below `high-risk`, Jazz narrows what injected content can do on its own: model-chosen URLs reach
public hosts only unless the agent lists private ones in `network.allowPrivateHosts`, the read
tools omit credential contents while allowing metadata and approved whole-file copies, outside content
reaches the model labelled as untrusted, and once a run has read it, egress tools need approval.
See [Secrets and egress](docs/security/secrets-and-egress.md).

### Before approving, ask

- Do I understand what this will do, and is it reversible?
- Am I in the right directory, and are the paths correct?
- For `git push`: the right remote and branch?

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

### Know where your API keys live

Jazz resolves every secret in this order, and uses the first hit:

1. **Environment variable**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, and so
   on. Nothing touches disk. Best for containers and CI.
2. **OS keyring**: macOS Keychain, or libsecret (`secret-tool`) on Linux. Used automatically
   when available. Keys already sitting in `~/.jazz/config.json` are moved here on next start.
   Entries are scoped to the Jazz home (service `jazz.<hash of the home path>`), so one
   `JAZZ_HOME` cannot read another's keys.
3. **`~/.jazz/config.json`**: the fallback when there is no keyring, e.g. a headless server with
   no session D-Bus. Jazz creates the file mode `0600` and repairs looser modes on load, but the
   keys are plaintext to anyone who can read that file (including `root`).

On a shared host, prefer 1 or 2. Set `JAZZ_DISABLE_KEYRING=1` to force the file path.

Secrets resolved from the environment or the keyring are never written back into the config
file. To check what is on disk:

```bash
cat ~/.jazz/config.json && ls -l ~/.jazz/config.json
```

Note that `~/.jazz/history/` and `~/.jazz/logs/` are separate plaintext stores and are not
covered by the keyring: treat them as sensitive in their own right.

---

## If something goes wrong

1. **Stop the run**: double-Escape interrupts generation and any running tool; otherwise exit the process.
2. **Check what happened**: `~/.jazz/logs/` has every tool invocation with its arguments;
   credential-bearing fields are shown as `<redacted>`.
3. **Recover**: inspect `git status` and `git reflog`, then restore only the affected paths or branch from a known-good commit. For non-Git files, use your backup or trash.
4. **Report it**: if the cause was Jazz acting without approval rather than an approval you granted, that is [in scope](#scope).

---

## Related

- [Tools & approval](docs/maintainers/tool-lifecycle.md): how gating and risk tiers are enforced
- [Tools reference](docs/tools/index.md): every tool and its tier
- [Configuration](docs/configure/jazz.md): `envAllowlist`, `autoApprovedCommands`
- [Local and air-gapped models](docs/getting-started/local-models.md): offline mode, local providers, and the network controls required for a real air gap
- **Security questions:** [Discord](https://discord.gg/yBDbS2NZju) · [Discussions](https://github.com/lvndry/jazz/discussions)
