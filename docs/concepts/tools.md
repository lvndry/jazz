---
description: "What a Jazz tool is, the three properties every tool declares, how a gated call runs in two phases, and how to add one without writing a plugin."
---

# Tools

A tool is a typed operation the model may request: a name, a description, an input schema, a
handler, and security metadata. The model asks; Jazz decides whether the call happens.

## Three properties, not one dial

Every tool declares **risk** (can this change something), **disclosure** (what class of
information its answer carries), and **egress** (does this send data off the machine). They are
independent, and [the security model](../security/index.md) explains why collapsing them loses
the cases that bite. Risk is the one an approval policy compares against:

| Tier        | Covers                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `read-only` | Reads, searches, web requests                                            |
| `low-risk`  | Todos, work state, subagents, and other bounded writes                   |
| `high-risk` | Anything that mutates: writes, deletes, moves                            |
| `unknown`   | `execute_command`, classified per command and then judged against the tier |

**`low-risk` is narrower than it sounds.** It does not mean "moderately dangerous things". Email,
calendar and Obsidian are skills that shell out through `execute_command`, so they sit at
`unknown`, and a `low-risk` run declines anything the classifier does not judge inspect-only or
minor. The [tool inventory](../tools/index.md) lists the exact classification of every tool.

## Gated tools act in two phases

A `high-risk` tool does not act when the model calls it. It returns a description of what it
*would* do, including a real preview diff for edits, and only after approval does Jazz invoke the
hidden `execute_*` half of the pair.

That is why you see the exact diff before a file is written, and why an unattended run can
decline cleanly instead of half-acting: the first phase produced a proposal, and nothing else
happened.

## When a tier is too coarse

Raising the whole policy to admit one command is the wrong move. Narrow the exception instead:

| Control               | Where                                             | Scope                              |
| --------------------- | ------------------------------------------------- | ---------------------------------- |
| Per-tool allowlist    | "Always approve this tool" in an approval prompt  | this session                       |
| Per-command allowlist | `autoApprovedCommands` in `~/.jazz/config.json`   | persisted, `execute_command` only  |
| Toolset trimming      | the agent's `deniedTools`                         | permanent, and the strongest       |

```json
{ "autoApprovedCommands": ["himalaya", "khal"] }
```

Command matching uses a parsed key, the binary plus its first subcommand, never a raw string
prefix. Approving `git status` therefore does not also approve `git status && rm -rf /`.

## How a tool reaches the model

Jazz registers built-in, MCP, skill-support and agent-defined custom tools, resolves the agent
and persona grants, subtracts explicit denials, applies caller requirements, and exposes what
survives.

Not all of it arrives the same way. Always-on categories send their full schema every turn.
Deferred categories send only a name and a one-line summary, and the model calls `search_tools`
to load a full schema when it needs one. That is what keeps a large MCP catalogue from costing
tokens on every turn of every conversation.

## Adding your own

Three routes, in increasing order of effort:

- **Custom tools**, declared in the agent's own JSON. A name, a schema, and either a fixed
  response or a command to shell out to. No code, no plugin, no restart.
- **MCP servers**, which bring an existing ecosystem's tools in. Jazz tracks whether you have
  trusted a server before exposing its tools broadly.
- **Built-in tools**, contributed to Jazz itself when the capability belongs to everyone. See
  the [tool lifecycle](../maintainers/tool-lifecycle.md).

## Related

- [Tool inventory](../tools/index.md): every tool, its risk, disclosure, and egress
- [Approvals](../security/approvals.md): what runs without asking, and what parks
- [Agent configuration](../configure/agents.md#custom-tools): declaring a custom tool
- [MCP](../configure/mcp.md): adding a server and trusting it
