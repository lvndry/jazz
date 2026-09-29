---
description: "Keep Jazz working toward an objective until it is verifiably done with /goal, hand it to the daemon when you leave, and rerun a prompt on a schedule with /loop."
---

# Goals and loops

A **goal** keeps the agent working toward an objective until it is done. A **loop** reruns a
prompt on a schedule until what it watches for happens.

## Goals

```text
/goal Get every recipe in ./recipes into the new format until ./check.sh passes
```

The agent starts immediately in the current conversation, using your safe or yolo approval
mode. Questions and approvals appear in chat.

When a turn ends, the next one starts on its own:

```text
↻ Goal recipes-new-format · turn 3
```

It keeps going until the agent reports the goal done. Jazz accepts that report only when it quotes
tool output showing the objective holds (a passing check, a file's contents, a command's result).
If the quote is missing or does not match, Jazz continues the goal and tells the next turn why.

There is no turn limit. Each turn is held to the agent loop's own limits (iterations, and the
token, cost, and time caps if you set them in config), like any turn. What goals and loops spend
together is unlimited by default; set a daily or monthly cap in `jazz` > Settings >
Spend Limits (`daemon.goals.dailyCostUSD`, `daemon.goals.monthlyCostUSD`). A reached cap holds the next cycle back until it clears,
without failing the goal: see [daily and monthly caps](./budgets.md#daily-and-monthly-caps). If the
goal needs you (a question or a blocker it cannot get past), the chat asks right there and carries
on with your answer.

| You want to                      | Do                    |
| -------------------------------- | --------------------- |
| See where it stands              | `/goal`               |
| Stop for now                     | Esc, or `/goal pause` |
| Continue, optionally steering it | `/goal resume [note]` |
| Drop it                          | `/goal clear`         |
| Say something while it works     | Type; it goes first   |

A conversation has one goal at a time. Setting another offers to drop the current one.

### Finish it in the background

Leave the chat with a goal unfinished and Jazz asks whether to keep working on it without you, and
what it may do unasked: reading only, low-risk changes, or everything. `jazz daemon` then carries on
in the same conversation. Anything above the authority you picked waits for you.

When it needs you, the daemon tells you right away: a desktop notification, or a push to your
phone through a [notify target](../configure/notifications.md) (ntfy, Telegram, Discord, a webhook). The next `jazz`
lists the conversation first under **Resume conversation (N waiting for you)**, marked with what it
is waiting on; open it and the chat shows the question or approval and carries on once you answer.
`jazz daemon status` shows everything waiting, and `jazz daemon pause` stops background work until
you resume it. A daily dollar or token cap (`daemon.dailyCostUSD`, `daemon.dailyTokens`) pauses it
on its own.

### Goals Jazz proposes

When a request clearly needs sustained work, the agent can propose a goal itself, with a plan and
the checks that will show it is done. Jazz shows the plan and asks before working on it. From a
shell, `jazz goal draft|start` plans a goal without a chat; see [`jazz goal`](../commands.md#jazz-goal).

## Loops

A loop repeats a prompt for the current agent in a separate conversation, through `jazz daemon`.
Starting one asks what its runs may do without approval and starts the daemon if needed.

### Interval syntax

```text
/loop <interval> <prompt>
/loop every <interval> <prompt>
```

Both forms mean the same thing. The prompt is everything after the interval.

| Interval      | Meaning          |
| ------------- | ---------------- |
| `1m` or `60s` | Every minute     |
| `10m`         | Every 10 minutes |
| `1h` or `60m` | Every hour       |
| `1h30m`       | Every 90 minutes |
| `1d`          | Every 24 hours   |

Use whole numbers with `s` (seconds), `m` (minutes), `h` (hours), or `d` (days).
Combine units without spaces, as in `1h30m`. Bare numbers, decimals such as `1.5h`,
and spelled-out units such as `10minutes` are invalid.

The minimum interval is **one minute**. `/loop 10s <prompt>` is refused; it is not rounded up.
Seconds are valid when the total is at least a minute, as in `90s` or `1m30s`.

```text
/loop 10m check whether the deploy finished and tell me
/loop 1h check whether the deploy finished and tell me
/loop every 1h30m check the build queue and report changes
```

An interval loop runs immediately, then waits the interval after each run finishes.
If a check takes two minutes, `10m` puts the next check about twelve minutes after the previous
one started. Use cron for runs aligned to clock times.

### Cron syntax

```text
/loop cron <minute> <hour> <day-of-month> <month> <day-of-week> <prompt>
```

Supply exactly five schedule fields, separated by spaces, without quotes. The rest is the prompt.
Schedules use this machine's timezone.

| Field syntax | Meaning     | Example                                                   |
| ------------ | ----------- | --------------------------------------------------------- |
| `*`          | Every value | `*` in the hour field: every hour                         |
| A number     | One value   | `8` in the hour field: 08:00                              |
| `,`          | A list      | `mon,wed,fri`                                             |
| `-`          | A range     | `mon-fri`                                                 |
| `/`          | A step      | `*/10` in the minute field: minutes 0, 10, 20, 30, 40, 50 |

Weekday names such as `mon` and month names such as `jan` are accepted.

```text
/loop cron */10 * * * * check whether the deploy finished and tell me
/loop cron 0 * * * * check whether the deploy finished and tell me
/loop cron 0 8 * * mon-fri read my calendar and unread mail and give me a five-line brief
```

These run every ten clock minutes, on the hour, and at 08:00 on weekdays, respectively.
A cron loop waits for its first scheduled time. A loop never overlaps itself, including while
a run waits for approval. Runs missed while the daemon was down collapse into one.

### Every ten seconds

Chat's `/loop cron` reads only five fields. For a schedule with seconds, use `jazz loop start`
from your shell with a six-field cron expression: **second, minute, hour, day-of-month, month,
day-of-week**.

```bash
jazz loop start --agent assistant --every '*/10 * * * * *' \
  'Check whether the deploy finished and tell me'
```

Replace `assistant` with your agent's name. This schedules checks at seconds 0, 10, 20, 30, 40,
and 50 of each minute. Actual starts depend on the daemon's polling and the previous run
finishing; this is not a precise ten-second timer.

### Manage a loop

`<loop>` is its name, full ID, or a unique ID prefix. `/loop list` shows this conversation's loops.

| Command                        | Action                                                  |
| ------------------------------ | ------------------------------------------------------- |
| `/loop` or `/loop help`        | Show usage                                              |
| `/loop list`                   | List this conversation's loops and their latest results |
| `/loop approve <loop>`         | Approve the action its run is waiting on                |
| `/loop reject <loop> [why]`    | Reject that action, optionally explaining why           |
| `/loop answer <loop> <answer>` | Answer its run's question                               |
| `/loop pause <loop>`           | Pause future runs                                       |
| `/loop resume <loop>`          | Resume a paused, failed, or budget-limited loop         |
| `/loop cancel <loop>`          | End the loop                                            |

Pausing or canceling lets an active run finish; a run waiting for your input is dropped.
Completed and canceled loops cannot resume. Resuming a budget-limited loop extends its budget.

A loop ends when its run says its purpose is met, when it reaches its run limit or end time, or when
you cancel it. Three failed runs in a row stop it for you to look at. A run that needs an approval
waits; `/loop approve <loop>` answers it. To set a name, timezone, run limit, end time, or spend
budget when starting, use [`jazz loop start`](../commands.md#jazz-loop) from your shell.

## Goal or loop?

|           | Goal                            | Loop                                         |
| --------- | ------------------------------- | -------------------------------------------- |
| Runs      | back to back until done         | on a schedule                                |
| Where     | your conversation               | a conversation of its own                    |
| Ends when | done is proven with tool output | its purpose is met, or its limit or end time |
| Good for  | finishing a job                 | watching for something, a recurring brief    |

Both run unattended only with the authority you grant, and an agent can never start one on its own:
starting, resuming, and approving are always yours. See [Approvals](../security/approvals.md).
