---
description: "Trace the Jazz agent harness through its runtime, context, tools, storage, adapters, security boundaries, tests, and evaluation suite."
---

# Maintaining Jazz

Use these pages to answer two questions: where does a change belong, and which invariant must it preserve?

## Read in this order

1. [Architecture](./architecture.md) — package ownership and dependency direction.
2. [Run lifecycle](./run-lifecycle.md) — input to final answer and persistence.
3. [Context lifecycle](./context-lifecycle.md) — pressure, trimming, compaction, and working state.
4. [Tool lifecycle](./tool-lifecycle.md) — registration, selection, disclosure, approval, and execution.
5. [Security threat model](../security/threat-model.md) — trust boundaries and non-goals.
6. [Testing and evals](./testing-and-evals.md) — proving correctness and harness lift.
7. [Documentation quality](./documentation.md) — writing code-backed concepts, lookup pages, and tutorials without filler or false completeness.

## Extend Jazz

- [Add a service](./add-a-service.md)
- [Add a model provider](./add-a-provider.md)
- Use the architecture map to decide whether a capability is a tool, skill, MCP server, adapter, command, or surface before writing code.

Every maintainer page should link to current source and nearby tests. Historical implementation plans are not runtime documentation.
