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
`--approval-policy` on a run, `autoApprove` in a workflow, the policy granted when accepting a
goal (`jazz goal accept <id> --approval-policy <tier>`, or the question chat asks as you accept),
or the one granted when starting a loop (`jazz loop start --approval-policy <tier>`, or the
question `/loop` asks).

| Policy           | Runs without asking                                                         |
| ---------------- | --------------------------------------------------------------------------- |
| `false` or unset | Nothing. A gated call asks, or is declined when nobody can answer           |
| `read-only`      | Reads, searches, web requests                                               |
| `low-risk`       | Adds memory writes, reminders, triggers, and shell commands judged low-risk |
| `high-risk`      | Adds everything gated: writes, edits, deletes, `execute_command`            |

Anything above the active policy is gated: in front of a person it asks, and unattended it is
declined or [parked](#with-nobody-there). That holds for every tool whose level is above
`read-only`, whether or not it has a proposal half. A plain `read-only` tool (`read_file`,
`web_search`) runs under every policy; removing it from the agent is how you deny it. That
includes the agent's own bookkeeping (`manage_todos`, `update_work_state`, `manage_scratchpad`)
and `spawn_subagent`: a sub-agent runs under its parent's policy, allowlists and tools, so
spawning one grants nothing new.

With no policy set, nothing runs unasked. `jazz run` without `--approval-policy`, a workflow
without `autoApprove`, a woken trigger or goal without a granted tier: each asks for every gated
call, or declines it when nobody can answer.

Interactive chat is different because you are at the keyboard. Its **safe mode** is the
`low-risk` tier: the classifier runs on each shell command, read-only and low-risk tools and
commands proceed, and anything high-risk asks. Chat starts in safe mode, and `/mode safe`,
Shift+Tab and the fullscreen toggle all return to it. **Yolo** mode is `high-risk`.

## Running fully unattended (yolo)

`high-risk` (also written `true`) approves every tool call without asking, shell included.
Nothing turns it on for you. Each surface has one explicit switch:

| Surface                | How to opt in                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| A workflow             | `autoApprove: high-risk` (or `true`) in its `WORKFLOW.md` frontmatter                     |
| `jazz run`             | `jazz run --agent <id> --approval-policy high-risk "…"`                                   |
| `jazz workflow run`    | the workflow's `autoApprove`; `--auto-approve` runs it headless at that tier              |
| Interactive terminal   | Shift+Tab to yolo mode for this session                                                   |
| A chat bot, one chat   | send `/mode yolo` in that conversation (`/mode safe` turns it back off)                   |
| A chat bot, every chat | start the bridge with `JAZZ_APPROVAL_POLICY=high-risk` (default `low-risk`)               |
| A goal or loop         | grant `high-risk` when accepting it (`jazz goal accept <id> --approval-policy high-risk`) |

`--auto-approve` on `jazz workflow run` does not raise the tier by itself: a workflow with no
`autoApprove` still runs at `false`. Before opting in, trim the agent's tools, set a spend cap
(`maxCostUSD`), and read [Unattended runs](./unattended-runs.md).

## Gated tools act in two phases

A gated tool does not act when the model calls it. The first phase returns a description of what
it would do, including a real diff for an edit. Only after approval does Jazz invoke the hidden
`execute_*` half.

So you see the exact diff before a file is written. And a declined call leaves nothing half-done,
because the first phase only produced a proposal.

Only the tool registered for an `execute_*` half can ask for it. Output from any other tool
that is shaped like an approval request (an MCP server's reply, a fetched JSON document) is
refused, and nothing runs. MCP results are always nested under `content` or
`structuredContent`, so a server cannot produce one at all.

A plain tool above `read-only` (`manage_memory`, `create_pdf`, a custom command tool, an
`http_request` other than `GET` or `HEAD`) has no proposal half. The executor asks with the
tool's name, level and arguments, and runs the tool once approved.

## Shell commands are classified individually

`ls` and `rm -rf /` are the same tool, so `execute_command` cannot have one risk level. Its level
is `unknown`.

When the verdict would change the outcome, Jazz asks a model to classify that specific command as
`read-only`, `low-risk`, or `high-risk`, then applies the policy to that.

Before any model is asked, Jazz reads the command the way the shell will and marks it
`high-risk` outright when it contains:

- an unterminated quote or expansion
- command or process substitution: `$(...)`, backticks, `$((...))`, `<(...)`, `>(...)`
- a redirection that reads or writes a file (discarding output to `/dev/null` and `2>&1` are
  fine)
- a command name built from a variable (`$EDITOR notes.md`)

No classifier or [policy plugin](../configure/plugins.md) verdict can lower those. The check is
about syntax only and knows no program names: what a particular program does (`curl`, `sh -c`,
`| xargs`) is for the classifier or the policy plugin to judge.

Three properties of the classifier itself are worth knowing:

- **Uncertainty is high-risk.** Ambiguity resolves upward, never downward.
- **The command is classified first, and the conversation cannot talk it down.** A clearly
  mutating command stays high-risk even if the user asked for something milder.
- **The command text is data, not instruction.** It arrives in tagged blocks the classifier is
  told to ignore instructions inside. In the case that matters, the thing being classified is
  attacker-controlled.

An unclassified command stays `unknown` and therefore fails closed.

## Narrowing without raising the policy

Reaching for a higher policy to admit one command is how an unattended run ends up able to delete
things. Narrow the exception instead:

| Control               | Where                                            | Scope                             |
| --------------------- | ------------------------------------------------ | --------------------------------- |
| Per-tool allowlist    | "Always approve this tool" in an approval prompt | this session                      |
| Per-command allowlist | `autoApprovedCommands` in `~/.jazz/config.json`  | persisted, `execute_command` only |
| Toolset trimming      | the agent's `deniedTools`                        | permanent, and the strongest      |

Command matching uses a parsed key, never a raw string prefix. Jazz lexes the command the way
the shell will, and the key is the binary plus the word right after it when that word is not a
flag: `git diff --stat` keys to `git diff`, `ls -la` to `ls`, `git -C repo status` to `git`. An
entry covers its own key and any longer key at a word boundary, so `git` covers `git push` and
`git status` covers `git status --short`.

A command that is more than one plain command has no key, and no entry ever approves it. That
covers control operators (`&&`, `||`, `;`, `|`, `&`, a newline), command or process
substitution, `${...}` expansion, any redirection, a comment, and a leading `NAME=value`
assignment. With `git status` and `git log` approved, all of these still ask:

```text
git status && rm -rf x      git status | sh          git status <(rm x)
git status $(rm x)          git status > ~/.bashrc   git status 2>/dev/null
git status `rm x`           git status & rm x        PAGER=x git log
```

Wrappers are part of the key: `sudo apt install x` keys to `sudo apt` and `npx jest` to
`npx jest`, so approving a command never extends to running it as another user or through a
package runner.

## With nobody there

An unattended run has no one to ask. It declines gated calls by default and says so, which is
usually what you want: the run finishes and reports what it could not do.

When the work genuinely needs a decision, `--park` saves the run instead, exits `2`, and waits.
`jazz runs show <id>` prints what it is waiting on. `jazz runs approve <id>` finishes it.
`jazz runs reject <id> --note "why"` turns it down with a reason the agent can use.

A resumed run keeps the policy and the `--auto-approve-tools` list it started with. Answering one
approval never widens the rest of the run to the default, and never drops a tier it was granted.
It also keeps the rest of its boundary: a tool list a webhook or peer narrowed it to, tools it
withheld, and its token, cost and time caps, of which it gets only what earlier segments left.

Over the daemon's HTTP API, approving or answering a parked run also needs the operator token
(`X-Jazz-Operator-Token`), so an agent that read the daemon token cannot approve its own run.
Rejecting needs only the daemon token. See
[granting authority over HTTP](../concepts/daemon.md#granting-authority-over-http).

Park only where somebody will actually look.

## Related

- [Tool inventory](../tools/index.md): the risk level of every tool
- [Tool lifecycle](../maintainers/tool-lifecycle.md): how a call is classified and executed
- [Unattended runs](./unattended-runs.md): what to decide before automating
- [Security model](./index.md): why risk, disclosure, and egress are separate questions
