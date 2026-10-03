---
description: "How a Jazz agent starts work that outlives the turn it was asked in, then resumes the same conversation when that work is done or due."
---

# Deferred work

Use deferred work for jobs that finish later or need a follow-up after the current turn:

| Shape               | Starts             | Comes back           | Resumes the conversation |
| ------------------- | ------------------ | -------------------- | ------------------------ |
| **Wake trigger**    | at a time you name | the agent runs again | yes, the exact one       |
| **Background jobs** | now, detached      | when every job ends  | yes, the exact one       |
| **Reminder**        | at a time you name | a person is told     | no                       |

## Ask for a follow-up

In a conversation, say what should happen and when:

```text
Remind me tomorrow at 09:00 to send the release notes.
```

To have Jazz do more work later:

```text
In 30 minutes, check whether this deployment finished and summarize the result
in this conversation.
```

Jazz asks for approval when required, then confirms the scheduled time. The machine must
be able to run Jazz when the follow-up is due; closing the chat does not prevent it.
For recurring checks, use a [loop](./goals-and-loops.md#loops).

## Reminders and wake triggers

A **reminder** delivers a note. Nothing runs and nothing is decided. "Tell me at six that the
lease expires" is a reminder.

A **wake trigger** runs the agent again, in the conversation it was scheduled from. Everything
already established is still there, so it picks up mid-thought instead of being re-briefed.
"Check whether the deploy finished, then compare the error rate to what we measured" is a
trigger.

If a person needs to read something, use a reminder. If a decision needs making, use a trigger.

## Background jobs

`run_background_jobs` runs several independent shell commands at once, with a concurrency cap and
per-job retry, without holding the turn open.

When every job reaches a final state, the conversation resumes with each job's status and output.

Use it to check multiple repositories, run a test suite per package, or probe a list of hosts:

```text
Run the test suite for each package as independent background jobs.
When all jobs finish, summarize the failures in this conversation.
```

## Scheduling requirements

Wake triggers use a one-shot `launchd` job on macOS or `at` on Linux. Background jobs start
a detached worker immediately. Both can run without an open chat or a running daemon.

The daemon provides fallback scheduling where the host scheduler is unavailable, retries
failed deliveries, and recovers job batches whose worker stopped. Keep it running on
containers or hosts without `launchd` or `at`.

## Delivered at least once

Jazz retries failed deliveries up to five times, starting after one minute and doubling
the delay up to an hour. Items that exhaust retries, or whose agent no longer exists,
remain marked as failed with an error.

A resumed turn can run twice if the process dies after doing the work but before recording
delivery. Design follow-ups so repeating an action is safe. Budget-limited partial answers
and parked approvals count as delivered; empty or provider-filtered answers are retried.

A desktop reminder on a host with no desktop session (a headless server, a system service) goes
to every [notify target](../configure/notifications.md) that takes reminders instead; with none
configured it is kept as failed with that reason rather than consumed unseen. A chat bridge only marks a reminder
delivered after the send succeeded, and a reminder whose chat it cannot resolve yet waits instead
of being dropped.

A late trigger tells the resumed agent its scheduled time, actual start time, and delay.

Absolute times are checked against the calendar: `2026-02-31 10:00` is refused rather than read as
March 3.

## When the resumed turn needs a person

A resumed run parks when it needs approval and notifies your [notify targets](../configure/notifications.md).
Answer from the CLI:

```bash
jazz runs approve <id>
jazz runs reject <id> --note "why"
```

## Related

- [Wake triggers, reminders, and background jobs](../tools/index.md): the tools, their risk
  levels, and exact arguments
- [Starting runs](./starting-runs.md): choosing between these and a schedule
- [Scheduled runs](../surfaces/scheduled.md): work on a clock rather than work an agent chose
- [Unattended runs](../security/unattended-runs.md): what to bound before any of this runs alone
