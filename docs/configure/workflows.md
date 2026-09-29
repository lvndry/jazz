---
description: "Configure WORKFLOW.md schedules, approval policies, model bindings, budgets, and delivery to notification targets."
---

# Workflow frontmatter

Set schedules, approval policies, and run budgets in a workflow's YAML frontmatter.
See [Workflows](../concepts/workflows.md) for the prompt body and [Guides](../guides/index.md)
for examples.

---

## Fields

```yaml
---
name: daily-standup-prep
description: "Prepare my daily standup notes"
schedule: "0 9 * * 1-5"
agent: my-dev-agent
autoApprove: read-only
skills:
  - github-action
catchUpOnRestart: true
maxCatchUpAge: 7200
maxIterations: 40
maxCostUSD: 0.20
maxTokens: 200000
maxDurationMs: 1800000
deliver: phone
---
```

| Field              | Type        | Required | Purpose                                                                                                                                                   |
| ------------------ | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | string      | ✅       | Workflow identifier used by every `jazz workflow` command                                                                                                 |
| `description`      | string      | ✅       | One-line summary shown in `jazz workflow list`                                                                                                            |
| `agent`            | string      | no       | Agent id or name to run this workflow with. Overridable at runtime with `--agent`                                                                         |
| `schedule`         | cron string | no       | When to run. Default frequency for `jazz workflow schedule`; `--cron` installs another beside it                                                          |
| `autoApprove`      | see below   | no       | Approval policy for every run of this workflow. Unset means `false`                                                                                       |
| `skills`           | string[]    | no       | Skills to make available to the agent for this workflow                                                                                                   |
| `catchUpOnRestart` | boolean     | no       | Whether a recent missed run may be replayed after daemon restart                                                                                          |
| `maxCatchUpAge`    | seconds     | no       | Past this age a missed run is skipped. Default 86400 (24 h)                                                                                               |
| `maxIterations`    | number      | no       | Iteration cap for this workflow. Default 100. Overridable with `--max-iterations`                                                                         |
| `maxCostUSD`       | number      | no       | Spend cap in USD, checked between iterations. Unset = uncapped. Overridable with `--max-cost-usd`                                                         |
| `maxTokens`        | number      | no       | Cap on cumulative prompt + completion tokens for this run (not sub-agents), checked between iterations. Unset = uncapped. Overridable with `--max-tokens` |
| `maxDurationMs`    | ms          | no       | Wall-clock budget with 50/80/90% agent pressure nudges. Unset = uncapped. Overridable with `--max-duration-ms`                                            |
| `deliver`          | string(s)   | no       | [Notify target](./notifications.md) name, or a list, that receives each run's answer. Its failures and approval requests go there too                     |

`maxCostUSD` and `maxTokens` are soft checkpoints, evaluated between iterations.
`maxDurationMs` is a deadline that interrupts a model call or tool in flight. See
[Configuration → run budgets](../configure/jazz.md#run-budgets)
for the full enforcement model and how `maxDurationMs` differs from `--timeout`.

There is **no** `autoApprovedCommands` field in frontmatter. That is a global config setting.
See [the note below](#the-low-risk-trap).

---

## `autoApprove`

Accepts exactly one of `false`, `read-only`, `low-risk`, `high-risk` or `true`, with `true` and
`false` unquoted. Leaving it out means `false`.

Any other value (`readonly`, `Read-Only`, `low_risk`, a quoted `"false"`, `yolo`) is invalid. `jazz workflow list` and `jazz workflow show` print the reason, and the workflow
refuses to run, to be scheduled, or to be installed from the library until it is fixed.

The same policy applies to every way a workflow runs: its schedule, catch-up after a restart,
`jazz workflow run --auto-approve`, and a plain `jazz workflow run`, where anything the policy
does not clear asks you first.

| Value       | Auto-approves                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `false`     | Nothing, and so does leaving it out. A gated tool is declined and the agent can continue or report the limitation |
| `read-only` | Reads, search, web requests, `git status`/`log`/`diff`/`blame`/`branch`                                           |
| `low-risk`  | + memory writes, reminders, triggers, and shell commands classified low-risk                                      |
| `high-risk` | + every gated tool: `write_file`, `edit_file`, `rm`, `mv`, `cp`, `mkdir`, `execute_command`                       |
| `true`      | Same as `high-risk`                                                                                               |

Exact per-tool tiers: [tool inventory](../tools/index.md).

### Running a workflow fully unattended (yolo)

To let a workflow run every tool without asking, write it out:

```yaml
autoApprove: high-risk # or true
```

Read
[Running fully unattended](../security/approvals.md#running-fully-unattended-yolo) first, and
prefer the narrower tier plus an `autoApprovedCommands` entry when one command is all the
workflow needs.

---

## The `low-risk` trap

`low-risk` covers memory writes, reminders, triggers, and commands classified low-risk.
Todos, work state, the scratchpad, and subagents already run at `read-only`.
Email, calendar, and file changes require approval when their risk exceeds the policy.

To permit a specific command, keep the tier low and add a narrow global grant:

```json
{ "autoApprovedCommands": ["git status"] }
```

Grants match the binary and its next word when that word is not a flag. They do not match
compound, redirected, substituted, or environment-prefixed commands. Granting a whole
binary such as `himalaya` permits its mutation commands too; see
[email and calendar setup](./email-calendar.md).

`high-risk` permits arbitrary shell commands and file mutations. Use it only when the
workflow needs that authority.

---

## `schedule`

Standard 5-field cron. **macOS caveat:** launchd's `StartCalendarInterval` supports only plain
integers and wildcards: no step values (`*/15`), ranges (`1-5`), or lists (`1,3,5`). Jazz
expands what it can into multiple entries and rejects what it can't with an explicit error
rather than silently scheduling something else.

launchd runs missed sleep slots once on wake; cron skips them. Powered-off machines
miss their slots. See [Scheduled runs](../surfaces/scheduled.md#sleep-missed-runs-and-catch-up)
for catch-up options.

---

## Where workflows live

Discovered in this order; later overrides earlier on name collision:

1. **Global**: `~/.jazz/workflows/<name>/WORKFLOW.md`
2. **Local**: `./workflows/<name>/WORKFLOW.md` in the current directory

---

## Related

- [Workflows](../concepts/workflows.md): the concept and the body of the file
- [Guides](../guides/index.md): complete examples
- [Surfaces → Scheduled](../surfaces/scheduled.md): running them unattended
- [Workflow commands](../commands.md#jazz-workflow): invocation and scheduling flags

## Run-time placeholders

The body may use these; Jazz fills them when the run starts, so one definition can serve
several [schedules](../concepts/workflows.md#several-schedules-one-workflow).

| Placeholder            | Value                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `{schedule.label}`     | Label of the schedule that fired, `manual` for a terminal run |
| `{schedule.cron}`      | Its cron expression, empty for a manual run                   |
| `{schedule.lastRunAt}` | ISO time this workflow last completed under that label        |
| `{run.startedAt}`      | ISO time this run started                                     |
