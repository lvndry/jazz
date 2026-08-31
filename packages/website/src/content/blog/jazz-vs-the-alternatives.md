---
title: "Jazz vs the alternatives: which agent runtime fits where"
description: "A factual comparison of Jazz against chat CLIs, hosted agent platforms, and plain cron plus scripts — what each does well, and where an open-source, self-hosted agent harness wins."
date: 2026-08-26
---

If you're evaluating AI agents, you're really choosing between four shapes of
product. They overlap less than the marketing suggests, and picking the wrong
shape costs more than picking the wrong brand. Here's the honest map.

## The four shapes

**Chat-first coding CLIs** (Claude Code, Codex CLI, Gemini CLI, Aider) put a
model in your terminal and let it edit code. They're excellent at the job in
their name: _coding, interactively_. What they generally don't do is leave the
terminal — running unattended on a schedule, answering you in Telegram while
you're out, or sitting inside a CI pipeline as a reviewer.

**Hosted agent platforms** (the cloud products from the big labs, plus
no-code automation suites with LLM steps) run _your prompts on their
machines_. That's convenient until your agent needs your files, your git
repos, your credentials, or your inbox — then you're either shipping secrets
to a third party or discovering the platform was never built for that.

**Plain cron + scripts + an API key** is the DIY shape. It works, right up
until the run hits something unexpected — and then there's no loop to recover,
no context strategy, no approval gate, no record of what happened. You
reinvent the harness badly, one bash script at a time.

**Agent harnesses** are the fourth shape: a general-purpose runtime whose
whole job is making one model usable as an autonomous worker on _your_
machine. Jazz is in this category by design.

## Where Jazz differs

Jazz doesn't try to be the best chat UI or the best autocomplete. It is built
around three claims that the other shapes don't make together:

**One agent, every surface.** The same configured agent works in your
terminal REPL, behind `jazz run` for scripts, in GitHub Actions, under
launchd/cron for scheduled runs, and in Telegram, Discord, or Slack. You
write the agent once; surfaces are deployment decisions, not rewrites.

**Self-hosted by default.** Jazz runs on your machine — laptop, home server,
or CI runner. Pair it with Ollama or llama.cpp and it works fully airgapped:
local inference, local telemetry, no outbound requests in offline mode.
Nothing about your filesystem, credentials, or mail ever needs to leave the
hardware you own.

**Approval as a first-class mechanism.** Every tool declares an honest risk
tier; mutating actions are gated; scheduled workflows carry a per-workflow
auto-approve policy that you set and can audit. The design goal is specific:
an agent you can leave running unattended _because_ you know exactly what it
can't do without asking.

## The trade-offs, stated plainly

Choosing Jazz means choosing the trade-offs that come with self-hosting:

- You operate it. Updates, logs, and the machine it runs on are yours.
- There's no hosted dashboard. Observability ships as local run records and
  OpenTelemetry export into whatever collector you already run.
- Chat surfaces require bringing your own bot tokens (Telegram, Discord).
- Interactive pair-programming inside an editor is not its center of gravity;
  tools built specifically for that will feel tighter in that one mode.

If those trade-offs bother you, use the tool shaped for you. If they sound
like _the point_ — an agent that lives on your machine, works while you
don't, and asks before touching anything real — that's what Jazz is for.

## Try it

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
```

MIT licensed, single binary, no runtime dependencies. The [quick start](/docs/start/quick-start)
gets you to a working agent in a few minutes, and the [playbooks](/docs/playbooks)
has forkable recipes for inbox triage, PR watchdogs, and research digests.
