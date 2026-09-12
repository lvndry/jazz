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

A **reminder** delivers a note. Nothing runs, nothing is decided, and the agent is not involved
when it fires. "Tell me at six that the lease expires" is a reminder.

A **wake trigger** runs the agent again with a prompt you gave it, resuming the exact
conversation it was scheduled from. Everything already established is still there, so the agent
picks up mid-thought rather than being re-briefed. "Check whether the deploy finished, then
compare the error rate to what we measured before" is a trigger.

If a person needs to read something, use a reminder. If a decision needs making, use a trigger.

## Background jobs are for fan-out

`enqueue_batch` runs several independent shell commands at once, with a concurrency cap and
per-job retry and backoff, without holding the turn open. When every job in the batch reaches a
final state, the conversation resumes and the agent is told each job's status **and what it
printed**. A batch exists to find something out, so an exit code alone would tell it nothing.

Use it when the work is wide rather than long: check forty repositories, run a test suite per
package, probe a list of hosts.

## None of this needs the daemon

A wake trigger installs a real one-shot job with the host's own scheduler, `launchd` on macOS or
`at` on Linux, which invokes Jazz at the scheduled time even if nothing else is running.
Enqueueing a batch starts a detached worker immediately, for a different reason: launchd's
calendar scheduling has minute resolution, so "run this now" either misses the current minute or
waits up to sixty seconds for it, and a two-second retry backoff cannot be expressed at all.

`jazz daemon`'s ticker is the fallback where neither host scheduler exists, which mostly means
containers and some CI images, and the safety net for a batch whose worker was killed mid-flight.
Scheduling with the host is best-effort: if it fails, registration still succeeds and the ticker
covers it.

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
