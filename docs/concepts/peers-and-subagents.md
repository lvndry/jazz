---
description: "Compare Jazz subagents for local delegated work with peers for authenticated requests between separately operated AI agents."
---

# Jazz peers and subagents

Both mechanisms let one agent ask another for help, but their trust and execution boundaries differ.

## Subagents

A subagent is a child run on the same Jazz installation. The parent calls `spawn_subagent` with
a task and a persona — `coder`, `researcher`, or `default` — and gets back a summary plus the
cost, not the child's transcript.

The point is context, not parallelism. A research task that would fill the parent's window with
raw sources runs in the child's window instead, and the parent receives a few hundred tokens of
conclusion. Ask for a structured handoff with `resultSchema` (a JSON Schema, root type `object`)
and Jazz validates the child's result before it reaches the parent, so a malformed answer fails
loudly instead of being parsed by hope.

The bounds, none of them optional:

- **A child never holds more tools than its parent.** The parent's effective toolset becomes the
  child's allowlist, so delegation cannot widen reach.
- **Depth is capped at 3.** A subagent can spawn one, but the chain stops.
- **30 iterations** by default, against the parent's 100.
- **Cost rolls up.** The child's spend is added to the parent's, and if the child's price is
  unknown the parent reports its own total as incomplete rather than confidently wrong.

## Peers

A peer is another explicitly configured Jazz agent, usually on another machine or under another operator. Requests cross a network boundary and are authenticated. The receiving agent applies its own disclosure and tool policy rather than inheriting the caller's permissions.

Use a subagent to split local reasoning or specialist work. Use a peer when another agent owns different data, tools, credentials, or responsibility. See [Agent-to-agent](./agent-to-agent.md) and [Connect peers](../guides/connect-peers.md).
