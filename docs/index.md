# Jazz Documentation

**Jazz runs your AI agent everywhere you are** — terminal, script, cron, CI,
chat. Any model, including local ones. These docs are organized by what you're trying to do.

---

## Start here

| I want to… | Go to |
| --- | --- |
| **Install it and see it work** | [Quick Start](./guide/quick-start.md) |
| **Know where it can run** | [Where it runs](./surfaces/index.md) |
| **Copy a finished thing** | [Cookbook](./cookbook/index.md) |
| **Understand a concept** | [Concepts](./concepts/index.md) |
| **Look up a flag or tool** | [Reference](./reference/index.md) |
| **See how it works inside** | [Internals](./internals/index.md) |
| **Understand the interface design** | [Design](./design/index.md) |

---

## Sections

### [Guide](./guide/index.md) — get running

- [Quick Start](./guide/quick-start.md) — install, configure a provider, first answer
- [Creating Agents](./guide/creating-agents.md) — build an agent for a job
- [Airgapped & Self-Hosted](./guide/airgapped.md) — fully offline with Ollama or llama.cpp
- [Observability](./guide/observability.md) — telemetry to your own OpenTelemetry collector or Langfuse

### [Where it runs](./surfaces/index.md)

One agent, many front doors. Start with the [surface matrix](./surfaces/index.md).

- [Headless](./surfaces/headless.md) — the `jazz run` contract: stdout/stderr, JSON envelope, per-chat memory, live events
- [Chat platforms](./surfaces/chat-platforms.md) — Telegram and Discord (shipped), Slack / Google Chat (bring your own bridge)
- [CI/CD](./surfaces/ci-cd.md) — PR review with inline comments, the `/jazz` assistant, release notes
- [Scheduled](./surfaces/scheduled.md) — launchd / cron, catch-up, unattended safety

### [Concepts](./concepts/index.md) — the building blocks

- [Agents](./concepts/agents.md) · [Personas](./concepts/personas.md) · [Skills](./concepts/skills.md) · [Tools](./concepts/tools.md) · [Workflows](./concepts/workflows.md) · [Scheduling](./concepts/scheduling.md)

### [Examples](./examples/index.md) — end-to-end walkthroughs

Interactive sessions from ask to artifact: [deep research into Obsidian](./examples/deep-research.md), [git workflows](./examples/git-commit-push.md), [security scans](./examples/security-scan.md), [and more](./examples/index.md).

### [Cookbook](./cookbook/index.md) — copy-pasteable recipes

Seven production-ready workflows with install steps and risk tiers: inbox triage, PR
watchdog, competitor watch, tech-debt radar, research digest, CI reviewer, release notes.

### [Integrations](./integrations/index.md) — connect things

- [LLM Providers](./integrations/providers.md) — 18 of them, including local
- [MCP Servers](./integrations/mcp.md) · [Web Search](./integrations/web-search.md) · [Email & Calendar](./integrations/email-calendar.md)

### [Reference](./reference/index.md) — look it up

- [CLI](./reference/cli.md) · [Configuration](./reference/configuration.md) · [Tools](./reference/tools.md) · [Workflow frontmatter](./reference/workflow-frontmatter.md)

### [Internals](./internals/index.md) — how it works

- [Agent loop](./internals/agent-loop.md) — iterations, budget pressure, meltdown detection
- [Context management](./internals/context-management.md) — token counting, trimming, compaction
- [Tools & approval](./internals/tools-and-approval.md) — risk tiers, two-phase execution
- [Sub-agents](./internals/subagents.md) · [Skills loading](./internals/skills-loading.md) · [Providers & models](./internals/providers-and-models.md)
- [Evals](./internals/evals.md) — measuring whether a harness change actually helped
- [Design decisions](./internals/design-decisions.md) — every harness choice and what it trades away
- [Code map](./internals/code-map.md) — for contributors

### [Design](./design/index.md) — how the interface is built

The terminal interface: the mark, the single-column layout, the six-hue palette, the
activity indicators, and the approval card. Includes the two rules that decide every case
not covered explicitly, and how the same design holds over SSH, in a cutting-edge terminal,
and with no terminal at all.

### [Security](../SECURITY.md)

The threat model, the approval tiers, hardening for unattended and chat-facing deployments,
and how to report a vulnerability. Lives at the repository root.

---

## Help

- [Discord](https://discord.gg/yBDbS2NZju) — fastest way to get an answer
- [GitHub Discussions](https://github.com/lvndry/jazz/discussions) — ideas and questions
- [Issues](https://github.com/lvndry/jazz/issues) — bugs and feature requests
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor guide
