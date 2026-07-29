# Security Policy

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

## Scope

Jazz is an agent that executes real actions on your machine: it reads and writes files, runs
shell commands, makes network requests, and drives external services. Some behavior that looks
alarming is deliberate and documented rather than a vulnerability.

**In scope** — please report:

- A gated tool executing without approval, or a way to bypass the approval system
- Privilege escalation past the configured `--approval-policy` / `autoApprove` tier
- The command allowlist matching more than it should (e.g. a prefix-matching bypass)
- Credential or API-key leakage into logs, telemetry, transcripts, or error output
- Command or argument injection reachable from untrusted input
- Anything that lets a remote party act on a host running Jazz without local consent

**Out of scope** — working as documented:

- `--approval-policy high-risk` (or `autoApprove: true`) permitting destructive commands. That tier exists to grant exactly that, and the docs say so.
- An agent acting on instructions embedded in content it fetched, when running at a tier that permits those actions. Prompt injection is a real risk, which is why the tiers and allowlists exist — see [Security guide](docs/security.md).
- Plaintext conversation transcripts under `~/.jazz/history/`. Documented; treat that directory as sensitive.
- An MCP server you configured doing something you did not expect. MCP servers are third-party code you chose to run.

If you are unsure which side of that line something falls on, report it — we would rather
triage a non-issue than miss a real one.

## Running Jazz safely

The threat model, the approval tiers, and hardening guidance for unattended and
chat-facing deployments are documented separately:

- [Security guide](docs/security.md) — approval system, best practices, container isolation
- [Tools & approval](docs/internals/tools-and-approval.md) — how risk tiers are enforced
- [Chat platforms → security](docs/surfaces/chat-platforms.md#security-for-chat-surfaces) — surfaces that accept input from other people
