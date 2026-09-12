---
description: "Compare Jazz subagents for local delegated work with peers for authenticated requests between separately operated AI agents."
---

# Jazz peers and subagents

Both mechanisms let one agent ask another for help, but their trust and execution boundaries differ.

## Subagents

A subagent is a child run on the same Jazz installation. It receives a bounded task and fresh context, can use a selected persona, and returns its result and cost to the parent. Delegation isolates context; it is not primarily a parallelism feature.

## Peers

A peer is another explicitly configured Jazz agent, usually on another machine or under another operator. Requests cross a network boundary and are authenticated. The receiving agent applies its own disclosure and tool policy rather than inheriting the caller's permissions.

Use a subagent to split local reasoning or specialist work. Use a peer when another agent owns different data, tools, credentials, or responsibility. See [Agent-to-agent](./agent-to-agent.md) and [Connect peers](../guides/connect-peers.md).
