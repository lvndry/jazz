---
description: "Learn how Jazz keeps long AI agent runs useful with budgets, context pressure, compaction, working state, tool-result offloading, and recovery checks."
---

# Long-running AI agent work

Long work fails when an agent loses the task, repeats itself, or reaches a hard limit without producing an answer. Jazz treats those as harness problems.

## What Jazz does

- **Budget pressure:** warns the model before iteration, time, token, or cost limits are exhausted.
- **Context pressure:** warns before the effective context window fills.
- **Compaction:** summarizes older history while preserving the system instructions and recent turns.
- **Working state:** stores the current objective, verified facts, open questions, and next actions outside the chat history.
- **Tool-result offloading:** moves large results into the agent workspace instead of repeatedly sending them to the model.
- **Meltdown detection:** notices low-diversity tool loops and asks the model to change course.

These mechanisms reduce failure; they do not make context loss impossible. Important conclusions should be written to an artifact or verified working state rather than left inside a large tool result.

## Control the run

Top-level runs default to 100 iterations. You can set iteration, cost, token, duration, and external timeout limits globally, per workflow, or on `jazz run`. See [Configure Jazz](../configure/jazz.md) and [Headless runs](../surfaces/headless.md).

For implementation details and exact thresholds, read the [context lifecycle](../maintainers/context-lifecycle.md) and [run lifecycle](../maintainers/run-lifecycle.md).
