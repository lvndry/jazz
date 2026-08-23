# Lexicon — what Jazz's words mean

**Reader job:** know which word to use, and which two words are not the same thing.

Jazz has a lot of nouns that sound alike. Several of them used to be genuinely
interchangeable, which is worse than having too many: a name that means two things cannot
be wrong, only ambiguous, so nothing ever forced the confusion into the open.

This page is the reference. Where two terms were collapsed into one, it says so, because
the old name still appears in older discussions.

---

## What runs

| Term           | What it is                                                                            | Where it lives             |
| -------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| **Agent**      | A configured entity: model, persona, toolset, reasoning effort. The thing you invoke. | `~/.jazz/agents/<id>.json` |
| **Persona**    | A system prompt plus a tool profile. Built-in: `default`, `coder`, `researcher`.      | `~/.jazz/personas/`        |
| **Skill**      | An instruction bundle the agent loads on demand with `load_skill`.                    | `~/.jazz/skills/`          |
| **Tool**       | One callable capability: built-in, MCP-sourced (`mcp_*`), or user-declared.           | —                          |
| **MCP server** | An external process that supplies tools.                                              | config                     |
| **Workflow**   | A file-defined prompt plus policy, runnable and schedulable.                          | `~/.jazz/workflows/`       |

## Units of interaction

This is where the collisions were.

| Term             | What it is                                                                                                    | How many           |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Conversation** | The thread. Identified by a caller-supplied key — `--conversation`, a Telegram chat id. Holds the transcript. | 1                  |
| **Turn**         | One user input through to one final answer.                                                                   | N per conversation |
| **Run**          | One execution of a turn. Has an id, a state, and a cost.                                                      | 1 per turn         |
| **Iteration**    | One LLM call and the tool batch it asked for, inside a run.                                                   | N per run          |
| **Sub-agent**    | A nested run from `spawn_subagent`. Internal: it never gets a run record of its own.                          | N per run          |

**A run is not a conversation.** A conversation is what was said; a run is one attempt to
say something. Several runs share one conversation, which is why `--conversation` gives an
unattended bridge memory across invocations.

> **Gone: "session".** It used to mean two unrelated things — a conversation's transcript,
> and a sitting at the terminal — with two incompatible id formats that met in one field.
> The transcript half is now just the conversation. The other half is a **log scope**.

| Term                 | What it is                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conversation log** | The append-only `.jsonl` whose replay yields a conversation. One file per conversation, one directory per agent, under `~/.jazz/history/conversations/`. |
| **Transcript**       | The content of a conversation. Not a separate thing: it is `conversation.messages`.                                                                      |
| **Log scope**        | The key that groups a run's log output into a file. A grouping key, never an identity — nothing reads it back.                                           |

## What the agent tracks about its own work

| Term             | What it is                                                                                                                                            | Written by                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Work state**   | The agent's account of what it is doing: goal, constraints, decisions, open questions, next step. One per conversation, discarded when the work ends. | the model, via `update_work_state` |
| **Todos**        | The list of work, with status and priority. Rendered in the interface.                                                                                | the model, via `manage_todos`      |
| **Work journal** | Append-only record of what happened, written at each compaction.                                                                                      | the runtime                        |
| **Memory**       | Facts that stay true *between* conversations.                                                                                                         | the model, via `manage_memory`     |

**Work state is subjective; a run is objective.** Work state is the agent's diary and can
be wrong or stale. A run's state is a fact about a process. They can disagree without
either being broken: a model can be planning its next step while the run it is planning
inside has already parked, waiting for someone to approve a tool.

> **Gone: "task".** It meant four things — this work state, todos, `spawn_subagent`'s
> `task` argument, and a family of error classes nothing ever threw. The errors are
> deleted, the state is *work state* (matching the directory it has always been stored in),
> and `task` survives only as the plain-English name for a brief you hand a sub-agent.
>
> **Gone: work items.** Work state used to carry its own list of work alongside todos,
> with a different status vocabulary, leaving the model to guess which to update. Todos
> won — they are the list the interface draws. The one idea worth keeping came with them:
> a todo records `verifiedBy`, so a completed item with nothing in it says plainly that
> the work was written but never checked. Progress and evidence stay separate fields;
> "unverified" is not a stage of work, and a status enum is the wrong place for it.

## Content

| Term           | What it is                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Message**    | One entry in a transcript: a role and content, sometimes tool calls or attachments. System prompts are never recorded — they are rebuilt every run. |
| **Attachment** | A file going *into* a run.                                                                                                                          |
| **Artifact**   | A file coming *out* of one, tagged `rendered` (produced from data) or `model` (generated).                                                          |

## Control

| Term                | What it is                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Approval**        | A gated tool asking for a yes. Carries a `toolCallId` so an approver in another process can answer the right one.                    |
| **Approval policy** | How much a run may approve for itself: `read-only`, `low-risk`, `high-risk`.                                                         |
| **Risk level**      | A tool's own classification, which the policy is compared against.                                                                   |
| **Park**            | A run stopping and saving itself because an approval needs a person who is not here. Resumed with `jazz runs approve`.               |
| **Interrupt**       | Stopping in-flight tools from the terminal (Escape twice).                                                                           |
| **Compaction**      | Summarizing older context to stay inside the window. **Trim** is the floor below it: dropping messages rather than summarizing them. |

## Where things are kept

```text
~/.jazz/
  agents/                     one JSON file per agent
  personas/  skills/  workflows/
  memory/                     durable facts, across conversations
  history/
    conversations/<agent>/    one append-only log per conversation
  work/<agent>/<conversation>/  work state and journal, discarded with the work
  runs/                       one record per run, pruned once terminal
  runtime/
```
