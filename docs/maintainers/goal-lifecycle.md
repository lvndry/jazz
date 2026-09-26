---
description: "The contract for inferred goals that outlive individual Jazz runs: routing, plan scope, evidence, budgets, pause and recovery."
---

# Goal lifecycle

> **Implementation contract.** A goal is not another name for a run or for model-authored work state. The controller owns its durable record; ordinary Jazz runs do the work one cycle at a time. Current limitations are called out below so the eval pipeline can measure them before the contract is widened.

## Goal, run, and work state

A **goal** is a durable user objective with an approved scope, plan, evidence criteria, aggregate budget, and lifecycle. A **run** is one `AgentRunner.run` invocation. A **conversation** holds messages across runs. **Work state** is the model's account of the task and can be stale or wrong. Keep these records separate: [run state](../../packages/core/src/agent/run/run-state.ts), [work state](../../packages/core/src/agent/context/work-state.ts), and [goal state](../../packages/core/src/agent/goal/goal-state.ts) answer different questions.

The goal record is authoritative for whether more work may start. Run records remain authoritative for what happened in one attempt. `update_work_state`, todos, and the model's final answer may help plan the next cycle, but none can mark the goal complete on their own.

## Route the user's turn

Goals start in three ways. In a conversation, the agent itself calls [`propose_goal`](../../packages/core/src/agent/tools/goal-tools.ts) when a request needs sustained work across runs; the tool is always on for the agent talking to the user, and subagents and goal cycles cannot use it. Once a proposal is saved, the rest of that turn is text only: the loop asks the model for no more tool calls and drops any it returns, so the work cannot start before the user accepts. `/goal <objective>` in chat and `jazz goal draft|start` from a shell ask for one directly, through a strict-schema planner call. Either way the plan is validated against the plan schema, and a malformed plan is returned for correction or shown as a failure, never started. A proposal with material open questions is shown as questions instead of a goal.

A proposed goal is stored in the `proposed` state and does nothing until the user accepts it: chat shows the plan after the turn and asks, and `jazz goal accept <id>` or `/goal accept <id>` accepts it elsewhere. Plan acceptance is never implied by the approval mode.

| Route        | Use when                                                                                                                         | Controller behavior                                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Action**   | The user clearly asks Jazz to do a bounded task and the intended outcome is understandable.                                      | Execute within the requested scope. Keep simple work as one ordinary run. Create a durable goal when the work needs multiple cycles or must continue after a run ends.                                                                                     |
| **Clarify**  | A missing choice materially affects scope, correctness, or consequences.                                                         | Ask the blocking question before dependent action. Independent read-only research may continue if it cannot commit the unresolved choice.                                                                                                                  |
| **Discover** | The user asks a question, seeks an opinion or feasibility check, or names a broad aspiration without authorizing implementation. | Do one bounded, read-only feasibility pass in the current interaction, then propose a parent goal, subgoals, finish evidence, assumptions, and open questions. Do not start daemon-owned continuation or make changes until the user accepts the proposal. |

“I want to improve Jazz” is a discovery request, not authorization to edit the repository or keep working in the background. The current flow asks before reading local project files and tells the user that relevant contents will be sent to the configured model provider. Discovery uses only read-only, non-egress file tools and is bounded by iteration, token, and time caps. Declining inspection leaves feasibility uncertain. “Fix this bug and make its regression test pass” can remain a direct action when its scope is clear. If success has no observable evidence, the plan should ask how to judge it or require review; do not invent a finish line silently.

## A plan does not grant tool authority

For discovery work, acceptance of the proposed plan authorizes the objective and scope the user accepted and allows the controller to create the durable goal. It does not approve every action in that plan. A clear direct Action request already supplies intent for the requested task; do not add a redundant plan-approval round for simple or tightly scoped work. Conversely, choosing a permissive execution mode does not mean the user accepted a proposed goal or plan.

The plan-acceptance decision and Jazz's **safe / YOLO** execution setting are separate:

- Plan acceptance answers: “Is this the work I want done, within these constraints?”
- The run's approval policy answers: “Which proposed tool actions may execute without a separate approval?”

The active policy, effective tool set, disclosure limits, and per-tool approval gates still govern every run. Goal continuation never widens them. A subgoal cannot add tools, raise the approval tier, change credentials, or expand the accepted scope. If the objective or constraints change materially, record a new plan revision and require acceptance before acting on that revision. See [tool lifecycle](./tool-lifecycle.md), [approvals](../security/approvals.md), and the [threat model](../security/threat-model.md).

Read-only feasibility work can still disclose information: local file contents are sent to the configured model provider after the user accepts inspection. Network tools are excluded from this discovery pass. Apply the existing disclosure and egress rules; see [secrets and egress](../security/secrets-and-egress.md).

## Controller-owned goal lifecycle

The goal controller owns a durable, versioned [goal record](../../packages/core/src/agent/goal/goal-record.ts) for the lifetime of the objective. A plan step is progress metadata, not a separate run or permission grant. Each cycle is an ordinary run with its own run ID, approval state, transcript, and usage.

A claimed cycle lives on the record as `cycle`: its run ID, the process that started it, and any pause or cancel requested while it runs. The cycle's prompt opens with a marker naming its run, so the cycle's own messages are found by that marker rather than by an offset that compaction or trimming would move. The field exists exactly while the cycle's outcome and spend are not yet folded into the goal, and the record schema rejects states that contradict it (an `awaiting-input` or `stopping` goal without a cycle, a terminal goal with one). The [goal states](../../packages/core/src/agent/goal/goal-state.ts) are:

- `proposed` waits for plan acceptance;
- `active` permits a cycle; one is running exactly when the record has a `cycle`;
- `awaiting-input` covers a user question or a parked tool approval;
- `paused` prevents new cycles; a paused goal can still hold a parked cycle;
- `stopping` records a pause or cancel while an in-flight cycle settles;
- `budget-limited` waits for an explicit budget change;
- `review-required` means progress or side effects cannot be safely inferred;
- `completed`, `failed`, and `canceled` are terminal.

Every way a cycle ends goes through one function, [`settleCycle`](../../packages/core/src/agent/goal/goal-reconcile.ts): the run finished, failed, or was canceled, a resume after an approval ended, the worker died, or the run ended while the goal was paused. It adds the run's spend exactly once and closes the cycle in the same write. Its precedence is a verified completion, then a requested stop, then a budget cap, then the disposition's next step. User controls are pure decisions in [`goal-controls`](../../packages/core/src/agent/goal/goal-controls.ts), shared by the chat command and the daemon API.

Every write is a compare-and-set on the goal version. File-backed activation uses a shared lock to enforce one active goal per source conversation across processes. A stale cycle cannot schedule work or complete a newer plan revision. Goal execution uses a private conversation so ordinary user turns do not race its transcript writes.

## Evidence decides completion

A run ending with a final answer means only that the run ended. The cycle prompt lists the accepted success criteria by number and asks for a strict disposition: `continue`, `complete`, `question`, or `blocked`. The disposition is the whole final answer, a fenced block, or the last JSON object after the model's prose. A `complete` disposition must cite every criterion by number with a quote that appears in tool output from the current cycle, either as stored or among the string values of a result stored as JSON, since a command's output is JSON-escaped inside its result. A quote must appear within a single tool result. Matching ignores whitespace differences and surrounding quote marks and allows up to two `...` elisions whose fragments, each at least six characters, appear in order; a quote of fewer than eight characters is not evidence. Paraphrase does not match. Results of `write_file` and `edit_file` are not evidence, because they mostly repeat what the model itself wrote. A command's output is still quotable even when the model chose the command, so a criterion that `echo` could satisfy is a weak criterion; prefer criteria a state check or a test run decides.

When the disposition is missing, malformed, or fails the evidence check, Jazz makes one schema-constrained repair call over the cycle's answer and a capped set of its tool outputs. The repaired disposition passes the same check, so repair can recover a misformatted answer but cannot invent a completion. If it still does not validate, the next cycle is told exactly what was not accepted (for example, which criterion had no supporting output) and runs again; after two consecutive unverified claims the goal moves to `review-required` with the reason. A criterion that something did not change or did not happen needs a check that prints a confirmation when it holds, and the cycle prompt says so. The evidence bar never lowers: no retry completes a goal without quotes from tool output. A `question` disposition stops for review with the question on the state itself (`review-required` with a `question` field), so every surface can show it; resuming with the answer as the note (`/goal resume <id> <answer>` or `jazz goal resume <id> <answer>`) carries the question and answer into the next cycle's prompt.

This checks provenance and criterion coverage, but the model authors the disposition and the controller does not independently verify final workspace state. Treat false-completion rate as a release-blocking eval metric; strengthening this to authoritative state checks is still required before claiming general goal completion correctness. Accepted evidence is stored with the goal, plan revision, and run ID. It is not a cryptographic snapshot of workspace state, and later edits do not invalidate it.

This follows Jazz's existing grounding rule: a matching tool call is not enough; the final answer must also agree with the observed result. See [`toolGroundedAnswerCheck`](../../evals/checks.ts) and the [eval methodology](./testing-and-evals.md).

## Budgets span the whole goal

Each cycle runs for at most the goal's `maxIterationsPerCycle` iterations (24 by default) before it must report, and receives the remaining aggregate token, duration, and known-cost caps, and a resumed approval receives what remains after the parked run's spend so far. Run records accumulate tokens, known cost, and active duration across resume segments, and goal usage preserves unknown cost as unknown. The [default budget](../../packages/core/src/agent/goal/goal-usage.ts) is sized for about a dozen cycles: every model call resends the conversation, so tokens grow with iterations, and a single call with the default persona and tools already costs tens of thousands of prompt tokens. A budget-limited goal continues only after an explicit budget change; `/goal resume` on one extends every cap by one default budget and says so, as does resuming a paused goal whose parked run exhausted the budget while it waited. Planning and discovery before acceptance are counted in tokens; their dollar cost is not priced.

Jazz's current `maxCostUSD`, `maxTokens`, and `maxDurationMs` are checked between run iterations, so a single model call or tool phase can cross a cap. `maxTokens` counts the run's own prompt and completion tokens, while cost rolls up delegated spend. A goal-level limit therefore must not just pass the same per-run cap to every cycle. Keep a finite cycle cap as an independent stop and be explicit that per-run soft checks can overshoot by one in-flight phase. See [budgets](../concepts/budgets.md) and [run lifecycle](./run-lifecycle.md).

Waiting for approval or a user answer pauses active-time accounting, but it does not erase usage. Parked runs retain the ordinary run TTL; the goal itself does not currently have an independent wall-clock expiry.

## Approval, pause, and cancellation

When a run parks for a high-risk tool action or asks a user question, move the goal to `awaiting-input`. Do not classify an approval request as a blocked goal, and do not start another cycle while the run is waiting. On an answer, resume the same parked run using Jazz's run-resume path; do not replay the whole cycle. Every surface that answers runs goes through one function, `resumeGoalAwareRun`. It returns the goal to `active` before the answered run works, so a pause or cancel in that window is recorded on the cycle, and it settles the cycle however the resume ends: finished, parked again on a second approval, or failed. The run's saved snapshot and approval decision exist precisely so a resumed run does not repeat already completed calls; see [run state](../../packages/core/src/agent/run/run-state.ts) and [`resumeRun`](../../packages/core/src/agent/run/resume.ts).

Pause and cancel first fence off future cycles. While an in-flight run is settling, show `stopping`, not `paused` or `canceled`. A parked run can be canceled, or retained while the goal is paused; answering a parked run is blocked until its goal resumes. A working run is not interrupted by a remote client and settles before the stop takes effect. Cancellation does not roll back an external action that already completed. Report uncertain actions to the user.

Resume keeps the same goal budget and accepted plan revision. A stale approval, pause, or evaluator result cannot reactivate a canceled or newer-version goal.

## Crash recovery and persistence

Persist a cycle claim before starting the run and persist its transcript, evidence, usage, and next goal state before making another cycle eligible. The daemon runs each cycle on its own fiber, so a long cycle does not hold up the daemon's other scheduled work, and it tracks the cycles it is running: a cycle whose owner is the daemon itself but which it is no longer running died there and is settled like any other dead cycle. A dead resumed run that still carries its parked snapshot goes back to waiting for its answer; any other dead run is closed as failed with the cause `interrupted`, so it cannot be re-parked and run outside the goal later. One corrupt goal file is reported and skipped when goals are listed, so it cannot stop every other goal. Each claim uses a stable run ID and records its process owner. A cycle cut off by the process stopping is not replayed: a fresh cycle starts with a note that the previous one was interrupted partway, so it checks the current state before redoing anything, which matters most for shell and network actions that cannot be rolled back. A restart is not the agent's failure, so an unattended goal carries on; after two interrupted cycles in a row the goal moves to `review-required`, since a cycle that keeps dying may be crashing the process itself. A pause or cancel requested before the crash still applies. A missing run record or an unverifiable owner also moves the goal to `review-required`.

Current run infrastructure exposes why the controller needs its own durable ledger: [run recording](../../packages/core/src/agent/run/run-recorder.ts) writes terminal run status best-effort, while the caller saves conversation history after the run returns. Parked runs are a stronger checkpoint: their unfinished transcript and pending input are persisted for later resume. A parked cycle's transcript is also saved to the goal's conversation so later cycles remember it. When the resume never completes, that transcript ends on an unanswered tool call, so any new run answers such calls with a result saying the outcome is unknown instead of sending a transcript the provider would reject. The existing [continuity kill test](../../evals/tasks/continuity/kill-test.ts) deliberately SIGKILLs a run and checks what its successor can actually recover.

The goal controller belongs to the Jazz daemon, not to a browser tab or terminal client. Clients observe and request state transitions; the daemon validates and commits them. The daemon's authenticated API requires a bearer token and rejects browser-origin requests; see [daemon](../concepts/daemon.md). A saved goal survives a client disconnect and can be reconciled after daemon process restart when the daemon returns. Work proceeds only while the daemon is running, so every surface that accepts a goal makes sure one is: it checks `/health`, which reports the goal owner id of the Jazz home the daemon serves, and starts a background daemon when none answers. A daemon holding the port for a different home is reported, not mistaken for this one. Restart on host boot or crash requires the host supervisor configured by `jazz daemon install`; Jazz cannot promise a remote machine is always available.

Active-goal detach to another host is excluded from this contract. Do not transfer an active goal until its plan revision, cycle claims, evidence, usage, approvals, and single-writer ownership fence can be transferred and reconciled together. A remote connection failure must not be treated as proof that the other host stopped.

## Proving the contract

Goal evaluations should check both routing and outcomes. Include ordinary questions, clear small actions, explicit long tasks, ambiguous aspirations, missing acceptance criteria, and high-impact requests. A false goal activation must not cause a write; a clear request must not acquire needless planning turns. For completion, check final workspace state and verification receipts, not the model's self-report.

Fault-inject crashes before and after each cycle checkpoint, approvals, pause/resume, plan revision, and completion. Assert that only one cycle can be claimed at a time, no cycle runs after an accepted pause/cancel, ambiguous effects require review, and total usage never resets. Compare goal mode and one-shot behavior with the same weak system-under-test and ceiling, reporting `Pass^k`, bootstrap confidence intervals, tokens, cost, elapsed time, false-complete rate, false activation rate, and budget overshoot. See [testing and evals](./testing-and-evals.md).
