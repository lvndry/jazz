---
description: "Choose Jazz tools, control their permissions, review proposed changes before approval, and extend an agent with custom tools or MCP servers."
---

# Tools

Tools let an agent read files, run commands, search the web, and perform other actions.
Your agent's tool settings and approval policy control which calls can run.

## Use tools in a conversation

Describe the result you want. The agent selects available tools and shows its calls as it works:

```text
Read the current git diff, run the relevant tests, and explain any failures.
```

Built-in tools cover files, commands, search, and task state. Use `jazz agent edit <agent>`
to add capabilities such as compositions or configured MCP servers. To forbid a tool,
set `deniedTools` in the [agent configuration](../configure/agents.md).

## Tool permissions

Every tool declares **risk** (can this change something), **disclosure** (what class of
information its answer carries), and **egress** (does this send data off the machine). They are
independent. The approval policy checks risk; see [the security model](../security/index.md)
for disclosure and egress controls:

| Tier        | Covers                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| `read-only` | Reads, searches, web requests, todos, work state, scratchpad, subagents    |
| `low-risk`  | Memory writes, reminders, and wake triggers                                |
| `high-risk` | File writes, deletes, and moves                                            |
| `unknown`   | `execute_command`, classified per command and then judged against the tier |

Email, calendar and Obsidian are skills that shell out through `execute_command`, so they sit at
`unknown`. A `low-risk` run declines anything the classifier does not judge inspect-only or
minor. The [tool inventory](../tools/index.md) has the exact classification of every tool.

## Reviewing changes

Before a `high-risk` tool acts, Jazz shows the proposed operation. File edits include a
preview diff. Approve to apply the change or reject to leave it unapplied.

## When a tier is too coarse

To allow a specific tool or command, use these controls:

| Control               | Where                                            | Scope                             |
| --------------------- | ------------------------------------------------ | --------------------------------- |
| Per-tool allowlist    | "Always approve this tool" in an approval prompt | this session                      |
| Per-command allowlist | `autoApprovedCommands` in `~/.jazz/config.json`  | persisted, `execute_command` only |
| Toolset trimming      | the agent's `deniedTools`                        | permanent, and the strongest      |

```json
{ "autoApprovedCommands": ["git status", "git log"] }
```

Command matching uses a parsed key, the binary plus its first subcommand, never a raw string
prefix. Approving `git status` therefore does not also approve `git status && rm -rf /`.

## Finding tools

Some tool schemas load only when needed. The agent uses `search_tools` to discover tools
and load their arguments.

## Adding your own

Add capabilities through your agent configuration or an MCP server:

- **Custom tools**, declared in the agent's own JSON. A name, a schema, and either a fixed
  response or a command to shell out to. No code, no plugin, no restart.
- **MCP servers**, which bring an existing ecosystem's tools in. Jazz tracks whether you have
  trusted a server before exposing its tools broadly.

## Related

- [Tool inventory](../tools/index.md): every tool, its risk, disclosure, and egress
- [Approvals](../security/approvals.md): what runs without asking, and what parks
- [Agent configuration](../configure/agents.md#custom-tools): declaring a custom tool
- [MCP](../configure/mcp.md): adding a server and trusting it
