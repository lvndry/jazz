---
description: "How a Jazz agent starts work that outlives the turn it was asked in, then resumes the same conversation when that work is done or due."
---

# Work that outlives the turn

A chat turn ends when the answer comes back. That is a problem for anything the answer depends
on and cannot wait for: a build that takes twenty minutes, a follow-up that matters tomorrow, a
hundred repositories to check.

Jazz gives an agent three ways to leave work running and come back to it. They differ in what
starts them and who they come back to, and picking the wrong one is the usual mistake.

| Shape               | Starts             | Comes back           | Resumes the conversation |
| ------------------- | ------------------ | -------------------- | ------------------------ |
| **Wake trigger**    | at a time you name | the agent runs again | yes, the exact one       |
| **Background jobs** | now, detached      | when every job ends  | yes, the exact one       |
| **Reminder**        | at a time you name | a person is told     | no                       |

## Reminders are for people, triggers are for agents

This is the distinction worth being precise about, because both take a time.

A **reminder** delivers a note. Nothing runs and nothing is decided. "Tell me at six that the
lease expires" is a reminder.

A **wake trigger** runs the agent again, in the conversation it was scheduled from. Everything
already established is still there, so it picks up mid-thought instead of being re-briefed.
"Check whether the deploy finished, then compare the error rate to what we measured" is a
trigger.

If a person needs to read something, use a reminder. If a decision needs making, use a trigger.

## Background jobs are for fan-out

`enqueue_batch` runs several independent shell commands at once, with a concurrency cap and
per-job retry, without holding the turn open.

When every job reaches a final state, the conversation resumes. The agent is told each job's
status **and what it printed**, because a batch exists to find something out and an exit code
alone would tell it nothing.

Use it when the work is wide rather than long: check forty repositories, run a test suite per
package, probe a list of hosts.

## None of this needs the daemon

A wake trigger installs a real one-shot job with the host's own scheduler, `launchd` on macOS or
`at` on Linux, which invokes Jazz at the scheduled time even if nothing else is running.
Enqueueing a batch starts a detached worker immediately, for a different reason: launchd's
calendar scheduling has minute resolution, so "run this now" either misses the current minute or
waits up to sixty seconds for it, and a two-second retry backoff cannot be expressed at all.

`jazz daemon`'s ticker is the fallback where neither host scheduler exists, which mostly means
containers and some CI images, and the safety net for a batch whose worker was killed mid-flight
and for retries. When the ticker delivers an item, it removes the host scheduler's one-shot job for
it, so no stale job is left behind to fire later.

A job's worker renews its claim (its lease) every minute while the job runs. A worker on the same
machine is judged by whether its process is still alive, not by the clock, so a laptop that sleeps
through a long job does not have that job taken away and run a second time.
Scheduling with the host is best-effort: if it fails, registration still succeeds and the ticker
covers it.

## Delivered at least once

A reminder, a wake trigger, and a batch's fan-in (the turn that hands the results back) are each
delivered at least once, never silently dropped:

1. **Claimed.** Whichever process gets there first (the host scheduler's one-shot job, the
   daemon's ticker, or a chat bridge's sweep) marks the item as being delivered, in one locked
   step. Nobody else fires it while that claim's process is alive. If the process dies mid-way,
   the next sweep takes the item again.
2. **Delivered.** The notification was shown, the chat message was sent, or the resumed turn
   finished or parked for approval. Only then is the reminder or trigger removed, and the batch
   marked delivered.
3. **Failed.** The error and the attempt count are kept on the item, and it is retried with a
   backoff (one minute, then doubling up to an hour), five attempts in all. After that, or when
   retrying cannot help (the agent no longer exists), it stays on disk as failed, and
   `list_reminders` and `list_triggers` show the error.

A desktop reminder on a host with no desktop session (a headless server, a system service) is
kept as failed with that reason rather than consumed unseen. A chat bridge only marks a reminder
delivered after the send succeeded, and a reminder whose chat it cannot resolve yet waits instead
of being dropped.

At least once means a turn can run twice when a process dies after the work but before recording
it. A trigger that fires late says so: the resumed turn is told when it was scheduled for, when it
actually fired, and how late that is, so a "leave for the airport at 9:00" that fires at 18:00
after the laptop slept is not acted on as if it were on time.

Absolute times are checked against the calendar: `2026-02-31 10:00` is refused rather than read as
March 3.

## When the resumed turn needs a person

Nobody typed anything to start a resumed run, so nobody is necessarily watching when it reaches a
gated tool.

It parks rather than dying or hanging. The run saves itself, sends a desktop notification naming
what it wants, and waits. `jazz runs approve <id>` finishes it; `jazz runs reject <id> --note
"why"` turns it down. Same mechanism a `--park` headless run uses.

## Related

- [Wake triggers, reminders, and background jobs](../tools/index.md): the tools, their risk
  levels, and exact arguments
- [Automation](../features/automation.md): choosing between these and a schedule
- [Scheduled runs](../surfaces/scheduled.md): work on a clock rather than work an agent chose
- [Unattended runs](../security/unattended-runs.md): what to bound before any of this runs alone
