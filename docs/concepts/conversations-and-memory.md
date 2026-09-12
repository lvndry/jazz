---
description: "Understand Jazz conversation history, per-run working state, durable memory, and when each kind of AI agent context is retained."
---

# Conversations, working state, and memory

Jazz has three kinds of continuity. They solve different problems.

## Conversation history

A conversation is a sequence of user, assistant, and tool messages. Interactive chat keeps one active conversation. Headless callers opt into continuity with a stable `--conversation` key; without it, a one-shot run is stateless.

## Working state

Working state belongs to the current task. It records the objective, verified facts, unresolved questions, and next actions so useful state can survive context compaction or a later continuation. It is not a claim about what the agent should remember forever.

## Durable memory

Memory persists across conversations and is opt-in per agent through named scopes. Agents can view and update permitted scopes; users can inspect and clear them with `jazz memory` commands.

Use conversation history for dialogue, working state for execution continuity, and memory for durable user or project facts. The [context lifecycle](../maintainers/context-lifecycle.md) explains how the runner injects each one.
