---
description: "What a Jazz persona is, how it shapes behaviour and can narrow an agent's tools, the placeholders it can use, and where custom personas come from."
---

# Personas

A persona is a reusable system prompt with a name. It decides how an agent works: its voice, its
priorities, what it does when a task is unclear.

It says nothing about which model runs. The same persona behaves recognisably on a frontier
model and on a local one.

Jazz ships four: `default` for general work, `coder` for code and git, `researcher` for
read-only investigation, and `summarizer`, which is internal and has no user to address.

## What a persona file looks like

One `PERSONA.md` per persona, frontmatter plus prompt:

```markdown
---
name: coder
description: A hacker-engineer who sees the links between systems and builds for the long term.
tone: technical
style: precise
---

You are {agentName}, a hacker-engineer. You think in connections…

{agentDescription}

# Environment

{environment}
```

Three placeholders are filled in at run time. They are what let one file serve many agents:

| Placeholder          | Becomes                                                        |
| -------------------- | -------------------------------------------------------------- |
| `{agentName}`        | The agent's name, so the persona addresses itself correctly    |
| `{agentDescription}` | The agent's own description, so one persona hosts many jobs    |
| `{environment}`      | Live machine facts: date, OS, shell, home, hostname, user, TTY |

Use `{environment}` rather than writing "you are on macOS" into the prompt. Hardcode the machine
and the persona is wrong the first time somebody else installs it.

## A persona can narrow tools, never widen them

An optional `toolProfile` lets a persona restrict what agents using it may reach:

- `categories` picks which built-in tool categories the persona wants. Omitted means all of
  them; an empty array means none, which is how `summarizer` runs with no tools at all.
- `deny` is a hard exclusion applied last, after categories and after the agent's own `tools`.

This only ever subtracts. A persona cannot grant a tool, undo `deniedTools`, raise a disclosure
ceiling, or change the approval policy.

That separation is the point. Installing a persona from the marketplace should never widen what
your agent can do to your machine.

## Where they come from

Built-in personas ship with Jazz. Your own live in `~/.jazz/personas/<name>/PERSONA.md`, written
by hand or with `jazz persona create`. The marketplace is the third source:

```bash
jazz persona list              # built-in and custom
jazz persona show coder        # read one, as the agent sees it
jazz persona browse            # marketplace, interactive install
jazz persona search            # everything the marketplace offers
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
