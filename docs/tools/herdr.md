---
description: "Agent-state reporting when Jazz runs inside a Herdr pane: identity, live working/blocked/idle state, and session restore."
---

# Herdr agent-state reporting

Jazz reports its state to [Herdr](https://herdr.dev) when it runs inside a Herdr
pane. This is the agent-side integration described in
[Herdr's add-herdr-support docs](https://herdr.dev/docs/add-herdr-support/):
Herdr injects `HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH` into every
process in a pane, and Jazz shells out to the Herdr CLI to keep the pane's
agent slot accurate.

## What you get

- **Identity**: the Herdr sidebar and `herdr agent list` show the running
  agent as `jazz` (plus the agent id, e.g. `coder`) instead of guessing from
  the TUI.
- **Live state**: Herdr shows the pane as `working` while a turn is in
  flight, `blocked` (with a reason like "Approval needed: execute_command …")
  when an approval, question, or secret prompt is waiting on you, and
  `idle` otherwise.
- **Session restore**: reports carry the conversation id and a resume
  command, so after a Herdr server restart the session can be reopened with
  `jazz agent chat <agent> --continue --conversation <id>`.

## How it works

Pane integration lives in `packages/cli/src/integrations/` behind a small
`PaneStateAdapter` contract (`pane-state.ts`), with a registry
(`pane-state-registry.ts`) as the only entry point the chat service sees —
`attachPaneStateReporting(store)` / `detachPaneStateReporting()`. The
Herdr implementation is `herdr.ts`. Adding another tiling workspace that
embeds agents (TUIOS and the like) is one new adapter file plus one entry
in the registry; the chat service does not change.

The adapter is active only when `HERDR_ENV=1` is set. It subscribes to the
UI store's session snapshot and coalesces it into one of the three Herdr
states:

| Jazz is doing this                            | Reported state |
| --------------------------------------------- | -------------- |
| Pending approval, active menu / question      | `blocked`      |
| Awaiting, thinking, streaming, tool execution | `working`      |
| Idle prompt, completed turn, turn error       | `idle`         |

Reports are fire-and-forget: the Herdr CLI is spawned with a 3 second
timeout, stdio ignored, and every failure dropped. A missing or slow Herdr
can never delay or break a chat. Seq numbers are persisted under
`~/.jazz/herdr/` so state stays monotonic across process restarts in the
same pane. On exit (including SIGINT/SIGTERM), Jazz releases the pane's
agent slot.

## Testing it

```sh
# Inside a Herdr pane, in one pane:
jazz agent chat coder "hello"

# In another pane (or on the host):
herdr agent list
```

Outside a Herdr pane the whole integration is a no-op and the reporter adds
no subprocess overhead.
