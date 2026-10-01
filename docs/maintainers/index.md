---
description: "Trace the Jazz agent harness through its runtime, context, tools, storage, adapters, security boundaries, tests, and evaluation suite."
---

# Maintaining Jazz

Use these pages to answer two questions: where does a change belong, and which invariant must it preserve?

## Read in this order

1. [Architecture](./architecture.md): package ownership and dependency direction.
2. [Run lifecycle](./run-lifecycle.md): input to final answer and persistence.
3. [Goal lifecycle](./goal-lifecycle.md): inferred intent, durable multi-run work, completion evidence, budgets, and recovery.
4. [Context lifecycle](./context-lifecycle.md): pressure, trimming, compaction, and working state.
5. [Tool lifecycle](./tool-lifecycle.md): registration, selection, disclosure, approval, and execution.
6. [Plugin lifecycle](./plugin-lifecycle.md): trusted code, artifacts, per-run sessions, and advisory hooks.
7. [Security threat model](../security/threat-model.md): trust boundaries and non-goals.
8. [Testing and evals](./testing-and-evals.md): proving correctness and harness lift.
9. [Design decisions](./design-decisions.md): why each choice is the way it is, and what it gives up.
10. [Documentation quality](./documentation.md): writing code-backed concepts, lookup pages, and tutorials without filler or false completeness.

## Reference

- [Interface design](./interface-design.md): the terminal's visual language, and the rules for any case it does not cover.
- [Conversation presentation](./presentation-documents.md): source facts, renderer projections, stream identity, and history migration.
- [Fullscreen ownership](./fullscreen-ownership.md): navigation, content anchors, bounded layout, and disposal.
- [Terminal rendering tests](./terminal-rendering-tests.md): native ANSI output checked against an independent terminal grid.
- [Remote handoff snapshot](./detach-snapshots.md): what a detached conversation carries to another host, and the ownership fence around it.

## Extend Jazz

- [Add a service](./add-a-service.md)
- [Add a model provider](./add-a-provider.md)
- Use the architecture map to decide whether a capability is a tool, skill, MCP server, adapter, command, or surface before writing code.

Every maintainer page should link to current source and nearby tests. Historical implementation plans are not runtime documentation.
