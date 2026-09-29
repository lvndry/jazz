---
description: "Schedule unattended Jazz runs with launchd or cron: workflow prompts on a clock, output written to a log, and delivered to your phone or chat through a notify target."
---

# Scheduled runs

Run a saved job every morning, on weekdays, or at another recurring time. Jazz
installs the schedule through launchd on macOS or cron on Linux.

## Schedule your first job

From a repository you want to summarize, create an agent named `daily-helper` with
`jazz agent create`. Choose a tool-capable model and the `coder` persona.

Create `workflows/daily-standup-prep/WORKFLOW.md` in that repository:

```markdown
---
name: daily-standup-prep
description: "Summarize yesterday's repository activity"
agent: daily-helper
schedule: "0 9 * * 1-5"
autoApprove: read-only
maxIterations: 20
maxDurationMs: 300000
---

Inspect git commits from the last day and the current working tree. Summarize
completed work, uncommitted changes, and anything needing my attention.
Do not modify files.
```

Test it from the same repository, then install the schedule:

```bash
jazz workflow run daily-standup-prep --auto-approve
jazz workflow schedule daily-standup-prep
jazz workflow scheduled
jazz workflow history daily-standup-prep
```

The test should produce a summary grounded in your commits and working tree. The
schedule runs at 09:00 on weekdays in the machine's timezone. The agent and its
provider credentials must remain available on that machine.

To send the result to your phone or chat, configure a
[notification target](../configure/notifications.md) and add
`deliver: <target-name>` to the frontmatter. To stop the schedule:

```bash
jazz workflow unschedule daily-standup-prep
```

## Use the daemon scheduler

For an always-on host without launchd or cron, switch to in-process mode and run
the daemon. It checks due schedules once per minute:

```bash
jazz config set scheduler.mode in-process
jazz daemon
```

You can also select `/settings` → **Scheduler** in the `jazz` home screen. See
[Scheduler configuration](../configure/jazz.md#scheduling).

---

## Platform requirements

- **launchd doesn't do cron arithmetic.** `StartCalendarInterval` accepts plain integers and wildcards only: no step values (`*/15`), no ranges (`1-5`), no lists (`1,3,5`). Jazz expands what it can into multiple entries and rejects what it can't with an explicit error rather than silently scheduling the wrong thing.
- **Schedulers start with a minimal environment.** launchd jobs don't inherit your shell's `PATH`, so Jazz writes an explicit one into the plist. If a workflow shells out to a tool installed somewhere unusual, use an absolute path.

---

## Approval policy

The workflow's `autoApprove:` tier decides what can run without asking. Calls above
that tier are declined.

| `autoApprove` | Auto-approves                                                        | Good for                                          |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| `false`       | Nothing                                                              | The agent receives a decline for every gated tool |
| `read-only`   | Reads, search, web, todos, work state, subagents, read-only commands | Digests, reports, watchdogs                       |
| `low-risk`    | + memory writes, reminders, triggers, low-risk commands              | Digests that track state                          |
| `high-risk`   | + file writes, shell, git commit and push                            | Jobs requiring unrestricted tool use              |

Skills such as email, calendar, and Obsidian run commands through `execute_command`.
Their mutations may require a higher tier. Prefer human approval or a narrowly scoped
command grant; see [email and calendar setup](../configure/email-calendar.md).

Pick the lowest tier that lets the job finish. See
[Approvals](../security/approvals.md) for policy details.

---

## Sleep, missed runs, and catch-up

macOS and Linux behave differently here, and the difference decides whether you need catch-up
at all.

**launchd fires on wake.** Missed sleep slots are combined into one run when the Mac
wakes. A powered-off machine misses its slots.

**cron skips missed slots.** If a Linux machine is asleep or off at the scheduled time,
the job does not run.

Either way, catch-up is explicit rather than automatic:

```bash
jazz workflow catchup      # list what missed its slot, pick, run
```

It is age-bounded: a missed run older than 24 hours is skipped (and recorded in
`jazz workflow history` as `skipped`), and per-workflow `maxCatchUpAge` overrides that. The
separate `catchUpOnRestart` flag covers the in-process daemon, meaning a slot missed because the
daemon was stopped rather than because the machine was asleep.

### If the schedule really cannot be missed

- **Pick a forgiving time.** Hourly, or 9 AM instead of 6 AM, gives the machine more chances to
  be awake.
- **Keep the machine awake** while a daemon runs: `caffeinate -i jazz daemon --foreground` on macOS,
  `systemd-inhibit --what=sleep jazz daemon --foreground` on Linux.
- **Wake it on purpose.** macOS can schedule a wake or power-on:
  `sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00` for a 6 AM job.
- **Run it somewhere always on**, such as a home server, a VPS, or a Raspberry Pi.

---

## Debugging a scheduled run

History keeps the last 20 runs of each schedule. A run whose process died before it finished
(a crash, a reboot mid-run) shows as `interrupted` once a daemon or CLI starts again.

```bash
jazz workflow scheduled <name>           # is it actually installed, and under which labels?
jazz workflow history <name>             # did it run? what did it do?
tail -f ~/.jazz/logs/<name>.log          # stdout
tail -f ~/.jazz/logs/<name>.error.log    # stderr
jazz workflow run <name> --auto-approve  # reproduce it by hand, same policy
```

Log files rotate at 10 MB and are deleted 14 days after their last write, so a workflow that
has not run for two weeks has no log left. See
[sizes and retention](../runtime-data/index.md#sizes-and-retention).

`jazz workflow run <name> --auto-approve` reproduces the scheduled approval policy
in the terminal.

Most scheduled-run failures are one of three things: the machine was asleep (see above), a
tool was declined by the policy tier, or a binary the workflow shells out to isn't on the
minimal `PATH`.

---

## Related

- [Workflows](../concepts/workflows.md): the file format and frontmatter
- [Starting runs](../concepts/starting-runs.md): the other unattended shapes, and when to pick which
- [Guides](../guides/index.md): scheduled recipes with install steps
- [Headless](./headless.md): for dynamic prompts instead of a fixed workflow file
