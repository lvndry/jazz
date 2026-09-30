---
description: "Use Jazz in your terminal: choose an agent, ask it to work on files and repositories, approve actions, steer a run, and resume conversations."
---

# CLI

Use the terminal when you want to work alongside an agent: inspect a repository, edit
files, research a question, or review its actions as they happen.

## Start a conversation

Open Jazz from the directory you want the agent to work in:

```bash
jazz
```

On first use, choose **Start setup** to create an agent and configure its provider.
See [Quick start](../getting-started/quick-start.md) if Jazz is not installed yet.

After setup, the home screen offers your recent agents. Select one with the arrow keys,
type a request, and press Enter. Tab opens the full agent picker. Type `/` to find home
commands such as `/resume` for earlier conversations, `/start` or `/new` for a fresh conversation, and
`/create` to create an agent, and `/settings` for providers, keys, appearance, and limits.

To open a particular agent directly:

```bash
jazz agent chat assistant
```

Replace `assistant` with the name you chose. Try a request that uses your current checkout:

```text
Review the last five commits. Explain the behavior changes and flag anything risky.
```

Jazz shows the response and tool activity as the agent works. Ask follow-up questions in
the same conversation; the agent keeps the earlier context.

## Give it files

Type `@` to choose a file, or name it directly. Relative paths use the directory where
you started Jazz; quote paths containing spaces.

```text
Summarize @README.md and list the setup steps.
Compare @"design notes.md" with the implementation and identify gaps.
Explain the errors in @~/Desktop/build.log and inspect the relevant source files.
```

Images, PDFs, audio, and video can also be attached this way. Media support depends on
your model; [companion models](../concepts/media.md) let you assign specialists for
analysis or generation. Web search and integrations need their own
[configuration](../configure/index.md).

## Approve actions and steer the work

Chat starts in **safe** mode: read-only and low-risk actions proceed, while high-risk
actions ask for approval. Review the proposed tool and arguments before accepting.
Reject a step when it is wrong; the agent receives the refusal and can revise its plan.

`/mode yolo` allows tools to run without asking, including shell commands. `/mode safe`
restores approvals. Shift+Tab switches modes. See [Approvals](../security/approvals.md)
for the policy and command-classification details.

While a run is active, type and submit a correction, such as:

```text
Keep the public API unchanged. Fix only the failing test.
```

The agent receives submitted messages at its next tool boundary. To interrupt a run,
press Esc twice quickly; the first press shows a hint. An open picker or overlay consumes
Esc first. In the fullscreen interface, interrupting with submitted messages waiting
starts the next turn with those messages. An interrupted action may already have made
changes; inspect them before retrying.

## Keep and manage conversations

| Command                  | Use it to                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| `/resume`                | Continue an earlier conversation                                 |
| `/new`                   | Start a fresh conversation with the current agent                |
| `/start`                 | Alias for `/new`                                                 |
| `/create`                | Create another agent                                             |
| `/agents`                | Choose another agent for the current conversation                |
| `/rename Release review` | Give this conversation a recognizable title                      |
| `/fork`                  | Continue with the same history on a separate conversation branch |
| `/skills`                | Browse installed procedures the agent can use                    |
| `/cost`                  | See conversation tokens and estimated cost, including subagents  |
| `/limit usd 2`           | Set a conversation cost limit; `/limit` shows current limits     |
| `/exit`                  | Leave the chat                                                   |

Conversations are saved locally. [Memory](../concepts/conversations-and-memory.md)
can carry preferences into future conversations; it is separate from conversation history.

## Work beyond one turn

- [Goals and loops](../concepts/goals-and-loops.md): use `/goal <objective>` to keep
  working until completion is verified, or `/loop 10m <prompt>` to check on a schedule.
- [Remote handoff](../concepts/detach.md): `/detach <host>` continues the conversation
  on a registered SSH server.
- [Headless](./headless.md): run an agent from scripts with `jazz run`.
- [Scheduled runs](./scheduled.md): save a repeatable job and put it on a clock.

Use `/help` for commands and shortcuts, or `/help goal` for a specific command. The
[command reference](../commands.md) lists every CLI flag and chat command.
