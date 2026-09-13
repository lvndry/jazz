# Built-in workflows

The workflows in this directory ship inside Jazz. `jazz workflow list` shows them alongside
your own, and they run exactly like a workflow you wrote yourself.

| Workflow           | What it does                                             | Schedule           | Runs unattended with |
| ------------------ | -------------------------------------------------------- | ------------------ | -------------------- |
| `weather-briefing` | Today's forecast and what to wear                        | `0 7 * * *` daily  | `read-only`          |
| `email-cleanup`    | Archives newsletters and promotions you did not read     | `0 * * * *` hourly | `low-risk`           |
| `market-analysis`  | Daily stock and crypto analysis with investment insights | `0 6 * * *` daily  | `true` (everything)  |

## Run one now

```bash
jazz workflow run weather-briefing                 # approve each gated tool by hand
jazz workflow run weather-briefing --auto-approve  # apply the workflow's own autoApprove tier
```

The second form is what the scheduler will do. Run it once in the terminal before you activate a
schedule: if it needs an approval nobody is there to give at 7am, you find out now.

Pick a different agent with `--agent <name>`. Caps such as `--max-cost-usd` and `--max-iterations`
override the workflow's frontmatter for one run.

## Put it on a schedule

```bash
jazz workflow schedule weather-briefing                          # weather-briefing/default, from its frontmatter
jazz workflow schedule weather-briefing --cron "0 19 * * *" --as evening   # a second one
jazz workflow scheduled weather-briefing                         # what is installed
jazz workflow history weather-briefing                           # what happened
jazz workflow unschedule weather-briefing/evening                # remove one
```

The `schedule:` line in the frontmatter is the default frequency; `--cron` adds another beside it,
and a prompt can tell them apart with `{schedule.label}`. Details in
[docs/concepts/workflows.md](../docs/concepts/workflows.md#several-schedules-one-workflow).

## Make it yours

Copy the directory to `~/.jazz/workflows/<name>/` for every project, or `./workflows/<name>/` for
one repository, then edit `WORKFLOW.md`. Closest wins: a copy with the same name shadows the
built-in. Other people's workflows are one command away with `jazz workflow browse`.

Every frontmatter field is documented in [docs/configure/workflows.md](../docs/configure/workflows.md);
how workflows fit with agents and skills is in [docs/concepts/workflows.md](../docs/concepts/workflows.md).
