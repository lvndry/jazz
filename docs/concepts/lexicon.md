---
description: "Look up Jazz terms for agents, conversations, runs, tools, memory, goals, loops, approvals, context management, and generated files."
---

# Lexicon

Look up terms used in Jazz commands, configuration, and the interface.

## What runs

| Term           | What it is                                                                                                     | Where it lives                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Agent**      | A saved configuration: model, persona, tools, and reasoning settings.                                          | `~/.jazz/agents/<id>.json`                          |
| **Persona**    | A system prompt plus a tool profile. Built-in: `default`, `coder`, `researcher`, `summarizer`.                 | `~/.jazz/personas/`                                 |
| **Skill**      | An instruction bundle the agent loads on demand with `load_skill`.                                             | `~/.jazz/skills/`, `~/.agents/skills/`, `./skills/` |
| **Tool**       | One callable capability: built-in, MCP-sourced (`mcp_*`), or user-declared.                                    | n/a                                                 |
| **MCP server** | A local process or remote service that supplies tools.                                                         | config                                              |
| **Workflow**   | A file-defined prompt plus policy, runnable and schedulable.                                                   | `~/.jazz/workflows/`                                |
| **Companion**  | A specialist model used for image, audio, or video analysis or generation. See [Model companions](./media.md). | agent configuration                                 |

## Units of interaction

| Term             | What it is                                                                                                            | How many           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Conversation** | The thread. Identified by a caller-supplied key such as `--conversation` or a Telegram chat id. Holds the transcript. | 1                  |
| **Turn**         | One user input through to one final answer.                                                                           | N per conversation |
| **Run**          | One execution of a turn. Has an id, a state, and a cost.                                                              | 1 per turn         |
| **Iteration**    | One LLM call and the tool batch it asked for, inside a run.                                                           | N per run          |
| **Subagent**     | A child run with its own context, working on a task delegated by its parent.                                          | N per run          |

A conversation contains many turns. Each run executes a prompt within that thread.
Pass the same `--conversation <id>` to separate `jazz run` commands to continue one conversation.

| Term                 | What it is                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conversation log** | The append-only `.jsonl` whose replay yields a conversation. One file per conversation, one directory per agent, under `~/.jazz/history/conversations/`. |
| **Transcript**       | The recorded messages and tool results in a conversation.                                                                                                |

## What the agent tracks about its own work

| Term             | What it is                                                                                                                                            | Written by                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Work state**   | The agent's account of what it is doing: goal, constraints, decisions, open questions, next step. One per conversation, discarded when the work ends. | the model, via `update_work_state` |
| **Todos**        | The list of work, with status and priority. Rendered in the interface.                                                                                | the model, via `manage_todos`      |
| **Work journal** | Append-only record of what happened, written at each compaction.                                                                                      | the runtime                        |
| **Memory**       | Facts that stay true _between_ conversations.                                                                                                         | the model, via `manage_memory`     |

## Goals and loops

| Term     | What it is                                                                                                                                                                                | Started by                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Goal** | An objective the agent keeps working toward, turn after turn, until it proves it holds with tool output. Each turn toward it is a **cycle**. See [Goals and loops](./goals-and-loops.md). | the user (`/goal`, `jazz goal`), or accepting a proposal |
| **Loop** | A prompt rerun on a schedule, in a conversation of its own, until it ends itself or hits a limit. Each rerun is a **run**.                                                                | the user (`/loop`, `jazz loop`)                          |

## Content

| Term            | What it is                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Message**     | One entry in a transcript: a role and content, sometimes tool calls or attachments. System prompts are never recorded; they are rebuilt every run. |
| **Attachment**  | A file going _into_ a run.                                                                                                                         |
| **Artifact**    | A file coming _out_ of one, tagged `rendered` (produced from data) or `model` (generated).                                                         |
| **Composition** | An HTML chart, dashboard, calculator, or other visual page, optionally rendered to PNG. See [Compositions](./compositions.md).                     |

## Control

| Term                | What it is                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Approval**        | A gated tool asking for a yes. Carries a `toolCallId` so an approver in another process can answer the right one.                  |
| **Approval policy** | How much a run may approve for itself: `read-only`, `low-risk`, `high-risk`.                                                       |
| **Risk level**      | A tool's own classification, which the policy is compared against.                                                                 |
| **Park**            | A run stopping and saving itself because an approval needs a person who is not here. Resumed with `jazz runs approve`.             |
| **Interrupt**       | Stopping in-flight tools from the terminal. Escape twice.                                                                          |
| **Compaction**      | Summarizing older context to stay inside the window. **Trimming** removes older messages when summarizing cannot free enough room. |

## Connections and background work

- **[Daemon](./daemon.md):** the background process that runs goals and loops and serves HTTP requests, webhooks, and peers.
- **[Webhook](./webhooks.md):** an authenticated endpoint that runs a fixed prompt with an external event's payload.
- **[Peer](./agent-to-agent.md):** a trusted remote agent that exchanges questions with your installation.
- **[Wake trigger](./deferred-work.md):** a later run that resumes the conversation it was scheduled from.
- **Reminder:** a scheduled note sent to you without starting an agent run.
- **Background job:** a shell command run separately, with its result returned to the conversation later.
- **[Remote handoff](./detach.md):** moving a conversation to an SSH server with `/detach`, then reclaiming it and its file changes.

For file locations, see [Runtime data](../runtime-data/index.md).
