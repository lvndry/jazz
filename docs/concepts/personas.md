---
description: "What a Jazz persona is, how it shapes behaviour and can narrow an agent's tools, the placeholders it can use, and where custom personas come from."
---

# Personas

A persona is a reusable system prompt with a name. It decides *how* an agent works: its voice,
its priorities, what it does when a task is ambiguous. It says nothing about which model runs or
which provider pays, so the same persona behaves recognisably on a frontier model and a local
one.

Jazz ships four: `default` for general work, `coder` for code and git, `researcher` for
read-only investigation, and `summarizer`, which is internal and has no user to address.

## What a persona file looks like

One `persona.md` per persona, frontmatter plus prompt:

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

Three placeholders are filled at run time, and they are what let one file serve every agent that
uses it:

| Placeholder          | Becomes                                                        |
| -------------------- | -------------------------------------------------------------- |
| `{agentName}`        | The agent's name, so the persona addresses itself correctly     |
| `{agentDescription}` | The agent's own description, so one persona hosts many jobs     |
| `{environment}`      | Live machine facts: date, OS, shell, home, hostname, user, TTY  |

Use `{environment}` rather than writing "you are on macOS" into the prompt. A persona that
hardcodes the machine is wrong the first time somebody else installs it, and the block is
assembled from real values on every run.

## A persona can narrow tools, never widen them

An optional `toolProfile` lets a persona restrict what agents using it may reach:

- `categories` picks which built-in tool categories the persona wants. Omitted means all of
  them; an empty array means none, which is how `summarizer` runs with no tools at all.
- `deny` is a hard exclusion applied last, after categories and after the agent's own `tools`.

This only ever subtracts. A persona cannot grant a tool that was not registered, undo an agent's
`deniedTools`, raise a disclosure ceiling, or change the approval policy. Behaviour and authority
are separate systems on purpose: installing a persona from the marketplace should never be able
to widen what your agent can do to your machine.

## Where they come from

Built-in personas ship with Jazz. Your own live in `~/.jazz/personas/<name>/persona.md`, written
by hand or with `jazz persona create`. The marketplace is the third source:

```bash
jazz persona list              # built-in and custom
jazz persona show coder        # read one, as the agent sees it
jazz persona browse            # marketplace, interactive install
jazz persona search            # everything the marketplace offers
```

## Persona or agent config

Put it in the persona when it should be true of every agent that adopts the behaviour. Put it in
the agent when it is specific to one job: provider, model, credentials, memory scopes, custom
tools, and restrictions all belong to the agent.

The test is whether you would want a second agent to inherit it.

## Related

- [Build a reusable accountability persona](../guides/goggins-accountability-agent.md): one
  written end to end, then used interactively, headlessly, and on a schedule
- [Agents](./agents.md): the configuration a persona is attached to
- [`jazz persona`](../commands.md): every subcommand
