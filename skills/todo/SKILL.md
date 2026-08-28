---
name: todo
description: Create and track task lists for complex multi-step work. Use when planning projects, breaking down work, tracking progress, or when a task has 3+ steps. Triggers on "plan", "todo", "task list", "break down", "step by step", or complex requests requiring multiple actions.
---

# Todo Management

Use `manage_todos` and `list_todos` to plan, track, and complete multi-step work.

## When to Use

**Create todos when:**

- Task has 3+ distinct steps
- Work spans multiple files or systems
- User asks for a plan or breakdown
- Complex debugging or investigation
- Multi-phase projects (research -> implement -> test)

**Skip todos for:** single-step tasks, simple commands, quick lookups.

## How It Works

### Writing todos

Call `manage_todos` with the **full list** of items. Every call replaces the previous list.

Each item has:

- `content`: what needs to be done (be specific and verifiable)
- `status`: `pending` | `in_progress` | `completed` | `cancelled`
- `priority`: `high` | `medium` | `low`

### Reading todos

Call `list_todos` (no arguments) to retrieve the current list with status counts.

### Progress tracking

1. Mark exactly **one** item `in_progress` at a time.
2. Mark items `completed` immediately after finishing — don't batch.
3. When starting a new item, send the full updated list via `manage_todos`.

## Workflow

### At task start

1. Analyze the request.
2. Call `manage_todos` with all planned steps (status: `pending`).
3. Briefly tell the user the plan.
4. Mark the first item `in_progress` and begin.

### During execution

1. Work through items in dependency order.
2. After finishing an item, call `manage_todos` with the item marked `completed` and the next one `in_progress`.
3. If you discover new steps, add them to the list in the same call.
4. If an item is blocked, set it to `cancelled` with a note in `content` explaining why.

### At task end

1. Call `list_todos` to verify everything is `completed` or `cancelled`.
2. Summarize what was accomplished and note any skipped items.

## Patterns

### Investigation / Debug

```
Reproduce -> Investigate -> Fix -> Verify
```

Items: get repro steps, reproduce locally, check logs, identify root cause, implement fix, add test, verify fix.

### Feature Implementation

```
Design -> Implement -> Test -> Ship
```

Items: review requirements, design API, create models, implement logic, write tests, manual QA, deploy.

### Research

```
Gather -> Analyze -> Recommend
```

Items: search existing solutions, review docs, compare approaches, list pros/cons, write summary.

## Anti-Patterns

- Vague items ("fix the bug") — be specific ("add null check in `parseConfig` for missing `host` field")
- Giant lists with 50+ items — break into phases, complete one phase before planning the next
- Never updating status — call `manage_todos` after every meaningful step
- Skipping todos for complex tasks — when in doubt, create the list
