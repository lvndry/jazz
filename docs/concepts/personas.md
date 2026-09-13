---
description: "What a Jazz persona is, how it shapes behaviour and can narrow an agent's tools, the placeholders it can use, and where custom personas come from."
---

# Personas

A persona is a reusable system prompt with a name. It decides how an agent works: its voice, its
priorities, what it does when a task is unclear.

Jazz keeps the persona body intact, then adds one `Jazz harness` block for cross-tool runtime rules,
capability indexes, and applicable project instructions. Tool-specific guidance stays with the tool
so it does not crowd the agent's identity out of the system prompt. The harness treats the
persona's identity, tone, style, priorities, and response patterns as a binding contract throughout
the conversation.

It says nothing about which model runs. You can attach the same persona to different models,
but how closely they follow it depends on the model and the conversation context.

Jazz ships four: `default` for general work, `coder` for code and git, `researcher` for
read-only investigation, and `summarizer`, which is internal and has no user to address.

## What a persona file looks like

One `PERSONA.md` per persona, frontmatter plus prompt:

```markdown
---
name: coder
description: A hacker-engineer who sees the links between systems and builds for the long term.
---

You are {agentName}, a pragmatic hacker-engineer.

{agentDescription}

{environment}

## Always

- Trace the system before editing it.
- Fix root causes and verify the result.

## Never

- Never hide uncertainty or claim an unrun check passed.
- Never add abstraction the problem does not need.

## Calibration

User: “Patch this null error.”

Coder: “The null originates earlier. I’ll fix the producer and cover the missing case.”
```

Three placeholders are filled in at run time. They are what let one file serve many agents:

| Placeholder          | Becomes                                                        |
| -------------------- | -------------------------------------------------------------- |
| `{agentName}`        | The agent's name, so the persona addresses itself correctly    |
| `{agentDescription}` | The agent's own description, so one persona hosts many jobs    |
| `{environment}`      | Live machine facts: date, OS, shell, home, hostname, user, TTY |

Use `{environment}` rather than writing "you are on macOS" into the prompt. Hardcode the machine
and the persona is wrong the first time somebody else installs it.

## A repeatable persona structure

Treat a persona as a behavioral specification rather than a character biography. Use four compact
parts:

- The opening identity says who the persona is in one concrete sentence.
- `Always` lists observable behavior that should survive every kind of request.
- `Never` blocks generic model habits and behavior that would break the character.
- `Calibration` demonstrates the voice in an ordinary conversation and a task-oriented one.

Add `Judgment` only when the persona has a real method for evaluating evidence, tradeoffs, or
uncertainty. Examples teach tone more reliably than a list of adjectives; keep them short enough
that the persona does not become a script.

## A persona can narrow tools, never widen them

An optional `toolProfile` lets a persona restrict what agents using it may reach:

- `categories` picks which built-in tool categories the persona wants. Omitted means all of
  them; an empty array means none, which is how `summarizer` runs with no tools at all.
- `deny` is a hard exclusion applied last, after categories and after the agent's own `tools`.

This only ever subtracts. A persona cannot grant a tool, undo `deniedTools`, raise a disclosure
ceiling, or change the approval policy.

That separation is the point. Installing a persona from the library should never widen what
your agent can do to your machine.

## Where they come from

Built-in personas ship with Jazz. Your own live in `~/.jazz/personas/<name>/PERSONA.md`, written
by hand or with `jazz persona create`. The library is the third source:

```bash
jazz persona list              # built-in and custom
jazz persona show coder        # read one, as the agent sees it
jazz persona browse            # library, interactive install
jazz persona search            # everything the library offers
```

## Persona or agent config

Ask whether you would want a second agent to inherit it.

Yes, and it belongs in the persona. No, and it belongs in the agent, along with the provider,
model, credentials, memory scopes, and tools.

## Related

- [Build a reusable accountability persona](../guides/goggins-accountability-agent.md): one
  written end to end, then used interactively, headlessly, and on a schedule
- [Agents](./agents.md): the configuration a persona is attached to
- [`jazz persona`](../commands.md): every subcommand
