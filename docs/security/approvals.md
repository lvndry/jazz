---
description: "How Jazz decides whether a tool call runs, asks, or is refused: risk levels, approval policies, the shell-command classifier, and what happens with nobody there."
---

# Approvals

Two separate controls decide whether a tool call happens, and confusing them is the usual
mistake.

**Availability** is whether the tool exists for this agent at all. Removing it means the model
never sees it and cannot request it. **Approval** is whether an available tool may execute
without asking. Denying a tool is a wall; an approval policy is a door with a lock.

## Risk levels and policies

Every tool declares a risk level. One dial decides which levels run unattended:
`--approval-policy` on a run, or `autoApprove` in a workflow.

| Policy      | Runs without asking                                                    |
| ----------- | ---------------------------------------------------------------------- |
| `false`     | Nothing. A gated call is declined and the agent continues or reports it |
| `read-only` | Reads, searches, web requests                                          |
| `low-risk`  | Adds todos, work state, subagents, and shell commands judged low-risk   |
| `high-risk` | Adds everything gated: writes, edits, deletes, `execute_command`        |

Anything above the active policy is gated: in front of a person it asks, and unattended it is
declined or [parked](#with-nobody-there).

## Gated tools act in two phases

A gated tool does not act when the model calls it. The first phase returns a description of what
it *would* do, including a real preview diff for an edit, and only after approval does Jazz
invoke the hidden `execute_*` half of the pair.

That is why you see the exact diff before a file is written, and why a declined call leaves
nothing half-done: the first phase produced a proposal and touched nothing.

## Shell commands are classified individually

`execute_command` cannot have one risk level, because `ls` and `rm -rf /` are the same tool. Its
level is `unknown`, and when the verdict could change the outcome Jazz asks a model to classify
that specific command as `read-only`, `low-risk`, or `high-risk` before the policy is applied.

Three properties of that classifier are worth knowing:

- **Uncertainty is high-risk.** Ambiguity resolves upward, never downward.
- **The command is classified first, and the conversation cannot talk it down.** A clearly
  mutating command stays high-risk even if the user asked for something milder.
- **The command text is data, not instruction.** It arrives in tagged blocks with instructions to
  ignore anything inside them, because the thing being classified is attacker-controlled in
  exactly the case that matters.

An unclassified command stays `unknown` and therefore fails closed.

## Narrowing without raising the policy

Reaching for a higher policy to admit one command is how an unattended run ends up able to delete
things. Narrow the exception instead:

| Control               | Where                                            | Scope                             |
| --------------------- | ------------------------------------------------ | --------------------------------- |
| Per-tool allowlist    | "Always approve this tool" in an approval prompt | this session                      |
| Per-command allowlist | `autoApprovedCommands` in `~/.jazz/config.json`  | persisted, `execute_command` only |
| Toolset trimming      | the agent's `deniedTools`                        | permanent, and the strongest      |

Command matching uses a parsed key, the binary plus its first subcommand, never a raw string
prefix. Approving `git status` does not also approve `git status && rm -rf /`.

## With nobody there

An unattended run has no one to ask. It declines gated calls by default and says so, which is
usually what you want: the run finishes and reports what it could not do.

When the work genuinely needs a decision, `--park` saves the run instead, exits `2`, and waits.
`jazz runs show <id>` prints exactly what it is waiting on, `jazz runs approve <id>` finishes it,
and `jazz runs reject <id> --note "why"` turns it down with a reason the agent can act on. Park
only where somebody will actually look.

## Related

- [Tool inventory](../tools/index.md): the risk level of every tool
- [Tool lifecycle](../maintainers/tool-lifecycle.md): how a call is classified and executed
- [Unattended runs](./unattended-runs.md): what to decide before automating
- [Security model](./index.md): why risk, disclosure, and egress are separate questions
