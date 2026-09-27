---
description: "Keep Jazz working toward an objective until it is verifiably done with /goal, hand it to the daemon when you leave, and rerun a prompt on a schedule with /loop."
---

# Goals and loops

Some work does not fit in one turn. A **goal** keeps the agent working toward an objective until it
is done. A **loop** reruns a prompt on a schedule until what it watches for happens.

## Goals

```text
/goal Get every recipe in ./recipes into the new format until ./check.sh passes
```

The agent starts right away, in the conversation you are in. There is no plan to approve first, and
nothing looks different from a normal chat: the same streaming, the same approvals under your safe
or yolo mode, questions asked inline. A goal changes how the work gets done, not how it looks.

When a turn ends, the next one starts on its own:

```text
↻ Goal recipes-new-format · turn 3
```

It keeps going until the agent reports the goal done. Jazz accepts that report only when it quotes
tool output showing the objective holds (a passing check, a file's contents, a command's result).
If the quote is missing or does not match, the goal goes on, and the next turn is told why. A goal
is finished when it is proven, not when the model says so.

There is no turn limit and no goal budget. Each turn is held to the agent loop's own limits
(iterations, and the token, cost, and time caps if you set them in config), like any turn. If the
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

When it needs you, the next `jazz` lists the conversation first under **Resume conversation (N
waiting for you)**, marked with what it is waiting on. Open it and the chat shows the question or
approval and carries on once you answer.

### Goals Jazz proposes

When a request clearly needs sustained work, the agent can propose a goal itself, with a plan and
the checks that will show it is done. Jazz shows the plan and asks before working on it. From a
shell, `jazz goal draft|start` plans a goal without a chat; see [`jazz goal`](../commands.md#jazz-goal).

## Loops

```text
/loop 10m check whether the deploy finished and tell me
/loop cron 0 8 * * mon-fri read my calendar and unread mail and give me a five-line brief
```

A loop reruns its prompt on an interval (at least a minute) or a cron schedule in your timezone, in
a conversation of its own. It never overlaps itself, and runs missed while the daemon was down
collapse into one. Starting one asks what its runs may do without asking.

A loop ends when its run says its purpose is met, when it reaches its run limit or end time, or when
you cancel it. Three failed runs in a row stop it for you to look at. A run that needs an approval
waits; `/loop approve <loop>` answers it. See [`jazz loop`](../commands.md#jazz-loop) for schedules,
budgets, and the shell commands.

## Goal or loop?

|           | Goal                            | Loop                                         |
| --------- | ------------------------------- | -------------------------------------------- |
| Runs      | back to back until done         | on a schedule                                |
| Where     | your conversation               | a conversation of its own                    |
| Ends when | done is proven with tool output | its purpose is met, or its limit or end time |
| Good for  | finishing a job                 | watching for something, a recurring brief    |

Both run unattended only with the authority you grant, and an agent can never start one on its own:
starting, resuming, and approving are always yours. See [Approvals](../security/approvals.md).
