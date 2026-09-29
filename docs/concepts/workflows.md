---
description: "A Jazz workflow is a Markdown file: the body is the prompt, the frontmatter says how it runs. Save it once, run it by name, put it on a schedule."
---

# Workflows

A workflow saves a job you want to repeat: a prompt, an agent, permissions, and run limits.
Use one for reviews, briefings, or checks you want to run by name or on a schedule.

## Create a workflow

First [create an agent](../getting-started/create-an-agent.md) named `assistant`. From the
project directory, create `workflows/project-status/` and save this as `WORKFLOW.md`:

```markdown
---
name: project-status
description: "Report recent commits and current uncommitted changes."
agent: assistant
schedule: "0 17 * * 5"
autoApprove: read-only
maxIterations: 40
maxCostUSD: 1.00
---

# Project status

Read the project files and inspect git status and git log without modifying anything.
Summarize commits between {schedule.lastRunAt} and {run.startedAt}; if the last-run time
is empty, use the last seven days. List uncommitted changes separately.
This is the {schedule.label} report.
```

Run it from the project directory:

```bash
jazz workflow run project-status --auto-approve
```

Jazz prints the report. `--auto-approve` uses the workflow's `read-only` policy, so you can
check the behavior it will have unattended. When the result is useful, install its Friday
17:00 schedule:

```bash
jazz workflow schedule project-status
```

See [Scheduled runs](../surfaces/scheduled.md) to set up delivery and inspect run history.

## What the frontmatter does

| Field                    | Decides                             |
| ------------------------ | ----------------------------------- |
| `agent`                  | Who runs it                         |
| `schedule`               | Its default frequency, as a cron    |
| `autoApprove`            | What it may do with nobody watching |
| `maxCostUSD` and friends | When to stop                        |

Every field is listed in [workflow frontmatter](../configure/workflows.md).

## Where Jazz looks

| Path                 | Applies to           |
| -------------------- | -------------------- |
| `~/.jazz/workflows/` | all your projects    |
| `./workflows/`       | this repository only |

Closest wins. A repository can have its own `code-review` without touching yours.

## Starting points

Jazz ships no workflows of its own. The [library](#the-library) offers workflows you can install and edit, from a morning weather briefing to a merged-pull-request recap.
Installed copies live in `~/.jazz/workflows/<name>/` and can be edited locally.

## Several schedules, one workflow

A workflow is a process definition. A **schedule** binds it to a cron and an agent, and one
workflow can have several. The id of a schedule is `<workflow>/<label>`; the frontmatter
frequency installs as `default`.

```bash
jazz workflow schedule project-status                                  # project-status/default, Fridays
jazz workflow schedule project-status --cron "0 9 1 * *" --as monthly  # project-status/monthly
jazz workflow scheduled project-status                                 # both, with their crons
jazz workflow unschedule project-status/monthly                        # just that one
```

The prompt can use these schedule placeholders:

| Placeholder            | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| `{schedule.label}`     | `default`, `monthly`, or `manual` for `jazz workflow run` |
| `{schedule.cron}`      | the cron that fired, empty for a manual run               |
| `{schedule.lastRunAt}` | when this workflow last completed under the same label    |
| `{run.startedAt}`      | now                                                       |

Each label keeps its own last-run marker, so the monthly recap covers the whole month even though
the weekly one ran four times in between. Catch-up treats each schedule on its own for the same
reason. Two schedules of one workflow may not share a cron.

## The library

Browse and install workflows:

```bash
jazz workflow browse             # pick one, read the whole file, install it
jazz workflow search             # list what the library offers
jazz workflow add <name>     # straight to ~/.jazz/workflows/<name>/WORKFLOW.md
```

Installing prints the full `WORKFLOW.md` and asks for confirmation. Review its prompt and
`autoApprove` tier before accepting. `--as <name>` installs under a different local name.
Contributing one is a pull request: [CONTRIBUTING.md](../../CONTRIBUTING.md#contributing-to-the-library).

## Workflow, skill, or agent?

A **workflow** is a job: this prompt, this agent, these limits.

A **[skill](./skills.md)** is know-how. The model loads it when a task matches. No prompt of its
own, and you cannot schedule it.

An **[agent](./agents.md)** is who does the work.

A workflow can list skills in its frontmatter to supply the procedures its agent should follow.

## Related

- [Workflow frontmatter](../configure/workflows.md): every field and its default
- [Scheduled runs](../surfaces/scheduled.md): installing and managing schedules
- [`jazz workflow`](../commands.md): list, run, schedule, history, catch-up
