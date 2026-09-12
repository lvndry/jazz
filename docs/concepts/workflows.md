---
description: "Package repeatable AI agent tasks as Jazz WORKFLOW.md files with prompts, schedules, approval policies, catch-up behavior, and run budgets."
---

# Workflows in Jazz

A workflow is a Markdown prompt with optional YAML frontmatter. It makes a task versionable, reviewable, runnable by name, and schedulable.

```markdown
---
name: weekly-review
description: "Review repository changes every Friday."
schedule: "0 17 * * 5"
agent: reviewer
autoApprove: read-only
maxIterations: 40
---

# Weekly repository review

Inspect commits from the last seven days. Report regressions, risky changes, and missing tests.
```

The body is the prompt. Frontmatter controls selection, scheduling, catch-up, approval, and optional iteration, cost, token, and duration limits.

Workflows are discovered from the built-in bundle, `~/.jazz/workflows/`, and `./workflows/`
under the current project. A local definition with the same name wins over a global or built-in
one. The checked-in GitHub Action keeps templates under `.github/jazz/workflows/` and copies the
rendered prompt into `./workflows/` before invoking Jazz.

Use `jazz workflow run <name>` in the foreground before installing a schedule. Exact fields and precedence are in [Workflow configuration](../configure/workflows.md); operational behavior is in [Scheduled runs](../surfaces/scheduled.md).
