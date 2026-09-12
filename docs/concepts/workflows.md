---
description: "A Jazz workflow is a Markdown file: the body is the prompt, the frontmatter says how it runs. Save it once, run it by name, put it on a schedule."
---

# Workflows

A workflow is a Markdown file. The body is the prompt. The frontmatter says how it runs.

```markdown
---
name: weekly-review
description: "Review repository changes every Friday."
agent: reviewer
schedule: "0 17 * * 5"
autoApprove: read-only
maxIterations: 40
maxCostUSD: 1.00
---

# Weekly repository review

Inspect commits from the last seven days. Report regressions, risky changes, and missing tests.
```

Save that as `workflows/weekly-review/WORKFLOW.md` and you can run it by name:

```bash
jazz workflow run weekly-review        # now
jazz workflow schedule weekly-review   # every Friday at 5pm
```

You could paste the same prompt into a chat instead. The file gives you three things a paste
does not: a name, a schedule, and a diff when somebody changes it.

## What the frontmatter does

| Field                    | Decides                             |
| ------------------------ | ----------------------------------- |
| `agent`                  | Who runs it                         |
| `schedule`               | When, as a cron expression          |
| `autoApprove`            | What it may do with nobody watching |
| `maxCostUSD` and friends | When to stop                        |

Those live next to the prompt on purpose. If someone changes `autoApprove` from `read-only` to
`high-risk`, that shows up in the pull request, right beside whatever prompt change they wanted
it for.

Every field is listed in [workflow frontmatter](../configure/workflows.md).

## Where Jazz looks

| Path                 | Applies to           |
| -------------------- | -------------------- |
| ships with Jazz      | everywhere           |
| `~/.jazz/workflows/` | all your projects    |
| `./workflows/`       | this repository only |

Closest wins. A repository can have its own `code-review` without touching yours.

## Workflow, skill, or agent?

A **workflow** is a job: this prompt, this agent, these limits.

A **[skill](./skills.md)** is know-how. The model loads it when a task matches. No prompt of its
own, and you cannot schedule it.

An **[agent](./agents.md)** is who does the work.

They combine. A workflow can list skills in its frontmatter: the workflow says what to do on
Friday, the skill says how that kind of work is done.

## Try it in the terminal first

```bash
jazz workflow run weekly-review --auto-approve
```

This is the same code path the scheduler uses. If it works here, it works on Friday.

Skip this and you get the usual surprise: the prompt worked when you tested it, because you
approved things by hand without noticing, and at 5pm nobody is there to approve them.

## Related

- [Workflow frontmatter](../configure/workflows.md): every field and its default
- [Scheduled runs](../surfaces/scheduled.md): what installing a schedule actually does
- [`jazz workflow`](../commands.md): list, run, schedule, history, catch-up
