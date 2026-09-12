---
description: "What a Jazz workflow is: a Markdown prompt with run policy in frontmatter, versioned in git, runnable by name and schedulable without changing the prompt."
---

# Workflows

A workflow is a Markdown file whose body is a prompt and whose frontmatter is the policy that
prompt runs under. It turns a job you would otherwise retype into something versionable,
reviewable, runnable by name, and schedulable.

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

```bash
jazz workflow run weekly-review        # now, in front of you
jazz workflow schedule weekly-review   # and from now on, on the clock
```

## Why the policy lives with the prompt

The frontmatter is the part that makes this more than a saved prompt. `autoApprove` decides what
runs unattended, the four budget caps bound the blast radius, `agent` pins who runs it, and
`schedule` is a cron expression that `jazz workflow schedule` installs with your OS scheduler.

Keeping them in one file means the prompt and the authority it runs with are reviewed together
and change together. A pull request that widens `autoApprove` from `read-only` to `high-risk` is
visible as exactly that, in the same diff as whatever prompt change motivated it.

The full field reference is [Workflow frontmatter](../configure/workflows.md).

## Where they live, and which one wins

| Source   | Path                 | Scope                |
| -------- | -------------------- | -------------------- |
| Built-in | ships with Jazz      | everywhere           |
| Global   | `~/.jazz/workflows/` | all your projects    |
| Project  | `./workflows/`       | this repository only |

A local definition beats a global one, which beats built-in. That is what lets a repository carry
its own `code-review` without disabling yours.

The checked-in GitHub Action uses this deliberately: templates live in `.github/jazz/workflows/`,
and the job renders one into `./workflows/` before invoking Jazz, so CI runs the repository's
version of the workflow and nothing else.

## Workflow, skill, or agent

- A **workflow** is a whole job: this prompt, this agent, these limits, this schedule.
- A **[skill](./skills.md)** is know-how the model loads when a task matches. It has no prompt of
  its own and cannot be scheduled.
- An **[agent](./agents.md)** is the identity that runs either one.

A workflow may name skills in its frontmatter, which is the usual combination: the workflow says
what to do this Friday, the skill says how that kind of work is done.

## Run it in front of you first

```bash
jazz workflow run weekly-review --auto-approve
```

Scheduled and unattended runs use the same code path, so a workflow that works in your terminal
under the policy it will actually run with is a workflow that works at 5pm on Friday. The reverse
is the common failure: a prompt tested interactively, where you approved things by hand without
noticing, that silently declines half its tools once nobody is there.

## Related

- [Workflow frontmatter](../configure/workflows.md): every field and its default
- [Scheduled runs](../surfaces/scheduled.md): what installing a schedule actually does
- [`jazz workflow`](../commands.md): list, run, schedule, history, catch-up
