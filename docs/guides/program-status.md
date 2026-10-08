---
description: "How Jazz tells your terminal what it is doing: OSC 7501 program status (working, blocked, done, error), terminal notifications, and OSC 7 working-directory reports."
---

# Program status in the terminal

Jazz tells your terminal what it is doing, so you can see at a glance — from
another tab — whether a run is working, waiting on you, finished, or failed.
Terminals that understand these signals (Ghostty, Rex, and more as the spec
spreads) show it as a tab spinner, a "needs you" badge, and a persistent
"finished, unviewed" mark that survives the next shell prompt.

Everything is plain escape-sequence output on the controlling terminal.
Terminals that do not know a sequence ignore it, so nothing changes if yours
does not support it yet.

## What gets reported

Jazz's run state machine already knows its state, so the reports carry it
directly — no screen-scraping:

| Jazz state                                  | Reported as                                                 |
| ------------------------------------------- | ----------------------------------------------------------- |
| Agent thinking or streaming                 | `state=working`                                             |
| A tool is running                           | `state=working` with the tool name                          |
| A tool is awaiting approval                 | `state=blocked kind=permission` with the approval text      |
| A question is waiting                       | `state=blocked kind=question` with the question             |
| A password/token is being asked             | `state=blocked kind=auth` with the prompt (never the value) |
| A file picker is open                       | `state=blocked kind=question`                               |
| A turn finished                             | `state=done`                                                |
| A `jazz run` failed                         | `state=error`                                               |
| A `jazz run` parked for a person (`--park`) | `state=blocked` with the parked input                       |

The blocked and error reports also **ping the tab** using the same terminal
notification protocols as [desktop notifications](../configure/notifications.md#desktop-notifications)
(OSC 9, 99, or 777, selected per terminal; tmux passthrough included), so a
run parked in another tab flashes or rings as well as showing a badge.

## OSC 7501

The primary signal is [OSC 7501](https://superlogical.com/rex/docs/build/program-status)
(the Program Status Protocol). Jazz emits reports of the form:

```text
ESC ] 7501 ; state=blocked:app=jazz:kind=permission:msg=<base64> ST
```

Reports are deduplicated: the same state does not re-emit while it holds, and
a repeated approval ping for the same ask does not re-ring within a few seconds.

Disable all 7501 reports with `JAZZ_OSC7501=0` (also `false` or `off`).

## Terminal notifications

When a run goes `blocked` or `error`, Jazz writes the terminal's native
notification sequence so the tab gets attention. Protocol selection and the
`JAZZ_NOTIFICATIONS_TERMINAL` override are shared with the desktop
[notifications](../configure/notifications.md) setting, so `off` or `osc9`
applies to both. Notifications only fire for state _changes_ — an idle run does
not ping.

## Current working directory

Jazz reports its working directory with [OSC 7](https://en.wikipedia.org/wiki/ANSI_escape_code#OSC)
at the start of a session and a `jazz run`. Terminals use it for tab titles and
cwd-aware tooling (tmux, iTerm2). Disable with `JAZZ_OSC_CWD=0`.

## What is not reported yet

- **Sub-agent status as separate records.** OSC 7501 supports a per-record `id`
  (e.g. `subagent/<agentId>`), which would let a terminal show each running
  sub-agent's own state. The encoder already supports `id` and `title`; wiring
  the per-sub-agent records is the next step.
- **`state=clear`** to explicitly drop the record on cancel — the next shell
  prompt already resets it in supporting terminals.

## Which escape codes Jazz uses

| Code             | Purpose                    | Status                                                                       |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------- |
| OSC 7501         | Program status (this page) | New here                                                                     |
| OSC 9 / 99 / 777 | Terminal notifications     | Reused from the desktop [notifications](../configure/notifications.md) stack |
| OSC 7            | Working directory          | New here                                                                     |
| OSC 52           | Clipboard                  | Already supported (fullscreen interface)                                     |
| OSC 11           | Terminal background query  | Already used for theme-aware colors                                          |
| OSC 8 / SGR 8    | Hyperlinks                 | Not yet emitted; a follow-up for link rendering                              |
| OSC 133          | Semantic prompt marks      | Not applicable — those describe shell prompts, and Jazz is a TUI             |
