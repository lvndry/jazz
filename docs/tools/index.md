---
description: "The complete Jazz tool registry: every tool name, its honest risk tier, and exactly what stands between a tool call and an action on your machine."
---

# Jazz tool inventory

Find the tool names to use in agent restrictions and approval grants. In chat, `/tools`
shows the tools available to the current agent. Use `jazz agent edit <name>` to change
its selected capabilities; use `deniedTools` to remove a specific tool.

Risk tiers determine what runs unattended. See [Approvals](../security/approvals.md)
and the [security model](../security/index.md).

---

## At a glance

|                                                                         | Count  |
| ----------------------------------------------------------------------- | ------ |
| **Agent-facing tools**                                                  | **71** |
| Hidden `execute_*` counterparts (the second half of each approval pair) | 16     |
| Total registered                                                        | 87     |
| `read-only`                                                             | 38     |
| `low-risk`                                                              | 17     |
| `high-risk`                                                             | 13     |
| `unknown`                                                               | 3      |

Plus, registered per agent rather than globally:

| Source     | Tools                                             | Notes                                                                                      |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Skills** | `find_skills`, `load_skill`, `load_skill_section` | Present when the agent has skills available. See [Skills loading](../concepts/skills.md)   |
| **MCP**    | `mcp_<server>_<tool>`                             | Discovered from the agent's tool list, connected lazily. See [MCP](../configure/mcp.md)    |
| **Custom** | whatever you define                               | Agent-config `customTools`: see [Agent configuration](../configure/agents.md#custom-tools) |

---

## How approval pairs work

Every tool above `read-only` is **gated**: under a policy that does not clear its level it
asks first, or is declined (or parked) when nobody can answer. With no policy, or
`false`, nothing clears. Gated tools include approval pairs and tools that ask before running directly.

The 12 approval pairs split proposing from acting: calling one does not act. It returns a
description of the intended action (including a preview diff for edits), and only after
approval, from a human or from the policy, does Jazz invoke the hidden `execute_*`
counterpart. A plain gated tool has no proposal half: the executor asks with its name, risk
level, and arguments, and runs the tool itself once approved.

Only the tool registered for an `execute_*` counterpart can ask for it. Any other tool output
shaped like an approval request (an MCP server's reply, a fetched JSON document) is refused
and nothing runs.

You never call `execute_*` names yourself; they are hidden from the model's tool list.

---

## What each tool reveals

Risk is not the same question as disclosure. Risk asks what a tool can do **to** the
machine; disclosure asks how freely its answer can be shared. The two do not correlate:
`read_file` is read-only and can reveal anything, `get_time` is read-only and reveals
nothing, `write_file` changes the machine and reveals nothing at all.

| Level      | Safe to tell                                                   | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`   | safe to tell anyone                                            | `add_reminder`, `cp`, `end_loop`, `mkdir`, `mv`, `propose_goal`, `report_goal_cycle`, `rm`, `web_fetch`, `web_search`, `write_file`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `internal` | the shape of this machine: paths, names, what is installed     | `analyze_media`, `cancel_batch`, `cancel_trigger`, `cancel_wait_for`, `cd`, `context_info`, `create_composition`, `create_pdf`, `find`, `generate_media`, `get_time`, `list_jobs`, `list_triggers`, `ls`, `pdf_page_count`, `pwd`, `register_trigger`, `search_tools`, `stat`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `private`  | your own material: file contents, memory, schedule, transcript | `ask_file_picker`, `ask_user_question`, `ask_user_secret`, `browser_act`, `browser_back`, `browser_close`, `browser_navigate`, `browser_screenshot`, `browser_snapshot`, `browser_tabs`, `cancel_reminder`, `computer_apps`, `computer_end`, `computer_foreground`, `computer_handoff`, `computer_input`, `computer_observe`, `computer_pointer`, `computer_wait`, `edit_file`, `enqueue_batch`, `execute_command`, `grep`, `http_request`, `list_reminders`, `list_subagents`, `list_todos`, `manage_memory`, `manage_scratchpad`, `manage_todos`, `read_file`, `read_pdf`, `retrieve_tool_result`, `spawn_subagent`, `steer_subagent`, `summarize_context`, `update_work_state`, `view_memory`, `view_scratchpad`, `wait_for`, `wait_subagents` |

A tool spanning two levels takes the more sensitive one. `edit_file` writes, but its approval
message carries a diff of your file, so it is `private`. `http_request` can reach
hosts on your own network once they are in `network.allowPrivateHosts`, so it is too.

**MCP and custom tools are `private`.**

---

## What leaves the machine

Risk and disclosure are both about this end of the call: what a tool does to your machine, and
what its answer would reveal. Neither asks about the **request**, and for a handful of tools
the request is where your material would actually leave.

| Sends | Tools                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| yes   | `browser_act`, `browser_navigate`, `computer_foreground`, `computer_input`, `computer_pointer`, `http_request`, `read_pdf`, `web_fetch`, `web_search` |

Three more, absent above only because they are registered per agent rather than globally:
`ask_peer` (`high-risk`), whose whole purpose is to put your model's words in front of somebody else's
agent; `request_clarification` (`low-risk`), offered only when a peer relationship is configured, which
lets the agent ask a peer one question back before answering theirs; and every MCP tool, whatever its
transport: where a server outside this codebase carries the model's arguments is not knowable from here.

This changes nothing in the terminal: approval tiers read the risk column, and a `read-only`
tool that fetches a URL is still auto-approved under `--approval-policy read-only`. It matters at exactly one door: a tool listed here is **never** granted to another
person's agent by a disclosure tier. It has to be named in that peer's `allow`, the same as a
tool that writes to disk. See
[Security model: how the ceiling is computed](../security/index.md#how-the-ceiling-is-computed).

The same holds for `manage_todos`, `update_work_state`, `manage_scratchpad` and
`spawn_subagent`. They are `read-only` for your own runs, but they write the agent's durable
bookkeeping or start child runs, so a peer reaches them only when its `allow` names them.

---

## The tools

### File Management

| Tool             | Risk        | Approval pair        | What it does                                                                                                              |
| ---------------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cd`             | `read-only` | none                 | Change the working directory for this session. Persists across subsequent tool calls.                                     |
| `cp`             | `high-risk` | `execute_cp`         | Copy a file or directory. Equivalent to shell cp/cp -r. Directories are copied recursively.                               |
| `edit_file`      | `high-risk` | `execute_edit_file`  | Edit an existing file against the snapshot returned by `read_file`; reject stale state before approval or execution.      |
| `find`           | `read-only` | none                 | Find files/directories by name, glob, or regex. Also advertised as `glob`. Searches names/paths, NOT contents (use grep). |
| `grep`           | `read-only` | none                 | Search file contents for text patterns (ripgrep with grep fallback). Supports regex, file filters, context…               |
| `ls`             | `read-only` | none                 | List directory contents. Supports recursive traversal, name filtering, hidden files. Default 200 results, c…              |
| `mkdir`          | `high-risk` | `execute_mkdir`      | Create a directory. Parents created automatically by default.                                                             |
| `mv`             | `high-risk` | `execute_mv`         | Move or rename a file or directory. Equivalent to shell mv.                                                               |
| `pdf_page_count` | `read-only` | none                 | Get total page count of a PDF without reading content.                                                                    |
| `pwd`            | `read-only` | none                 | Print the current working directory.                                                                                      |
| `read_file`      | `read-only` | none                 | Read a UTF-8 text file with numbered lines and a full-file edit snapshot; sinceByte follows appended content.             |
| `read_pdf`       | `read-only` | none                 | Extract text and tables from a PDF. Use pdf_page_count first for large files. Supports page ranges.                       |
| `rm`             | `high-risk` | `execute_rm`         | Remove a file or directory. May be irreversible.                                                                          |
| `stat`           | `read-only` | none                 | Check file/directory existence and get metadata (type, size, times).                                                      |
| `write_file`     | `high-risk` | `execute_write_file` | Write content to a file, creating it if needed. Replaces entire file content.                                             |

### Shell Commands

| Tool              | Risk       | Approval pair             | What it does                                                                                                                                                                                                  |
| ----------------- | ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute_command` | `unknown`  | `execute_execute_command` | Run a shell command when no dedicated tool exists. Each command is classified `read-only`, `low-risk`, or `high-risk`, and the active tier then applies to that verdict. Stdout/stderr capped at 256 KB each. |
| `wait_for`        | `unknown`  | `execute_wait_for`        | Watch in the background until a command exits 0, re-running it on an interval as tight as 250 ms. Returns at once; the agent is woken when the condition holds or after 15 minutes at most.                   |
| `cancel_wait_for` | `low-risk` | none                      | Cancel a pending `wait_for` by batch id (get the id from wait_for first).                                                                                                                                     |

`wait_for` runs as a background job (the same worker as `enqueue_batch`), so the agent keeps
working and is woken with the last check's output when the condition holds or the time runs out.
`cancel_wait_for` cancels the batch that `wait_for` created; for waits longer than 15 minutes, `register_trigger` suspends the run and resumes it later.

In the interactive terminal, an operator can also type `! <command>` (the space after `!` is
required). That explicit shell escape
uses the same cwd resolution, environment sanitization, denylist, timeout, interruption, and
output caps as `execute_command`, then gives the result to the agent as context. It is not
available through `jazz run` or remote chat surfaces.

### Web Search

| Tool         | Risk        | Approval pair | What it does                              |
| ------------ | ----------- | ------------- | ----------------------------------------- |
| `web_search` | `read-only` | none          | Search the web for real-time information. |

### Web Fetch

| Tool        | Risk        | Approval pair | What it does                                      |
| ----------- | ----------- | ------------- | ------------------------------------------------- |
| `web_fetch` | `read-only` | none          | Fetch and extract text content from a public URL. |

### HTTP

| Tool           | Risk        | Approval pair | What it does                                                                                                                                                                              |
| -------------- | ----------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_request` | `high-risk` | none          | Send HTTP requests to public or private hosts. Supports all methods, headers, query params, and body formats. Requests run automatically unless a global URL approval list is configured. |

### Todo

| Tool                | Risk        | Approval pair | What it does                                                                                                 |
| ------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `list_todos`        | `read-only` | none          | Read the current todo list. Returns all items with their status and priority.                                |
| `manage_todos`      | `read-only` | none          | Create or update the todo list. Send the FULL list of items each time (replaces the previous list). Use thi… |
| `update_work_state` | `read-only` | none          | Record where you are in the current task so it survives compaction and resuming later. Patches o…            |

### Memory

Memory tools are in the built-in bundle. Deny `manage_memory` to prevent writes. See [Memory](../concepts/conversations-and-memory.md).

| Tool            | Risk        | Approval pair | What it does                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view_memory`   | `read-only` | none          | Consult relevant memory when prior context could improve the answer.                                                                                                                                                                                                                                                                   |
| `manage_memory` | `low-risk`  | none          | Create with an explicit relevance topic, or amend, delete, or rename, using an exact quote from authenticated user input. The receipt names where the entry lands (`create personal/when/food/favorite-fruit.md`) and shows a diff of the entry: the new claim for a create, old and new for an amend, the removed claim for a delete. |

`update_work_state` lives with the todo tools (always-on). It is scoped to one conversation and discarded when the task ends, unlike memory which persists across conversations. See [Context management](../concepts/context-management.md).

### Workspace

Scratchpad tools are in the built-in bundle. Use them for working drafts, research material,
and intermediate files that should persist across conversations.

| Tool                | Risk        | Approval pair | What it does                                                                                          |
| ------------------- | ----------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `view_scratchpad`   | `read-only` | none          | View your durable scratchpad: drafts, research dumps and intermediate artifacts too large for memory. |
| `manage_scratchpad` | `read-only` | none          | Save durable working drafts, research dumps, or intermediate artifacts too large or provisional…      |

### Reminders

Opt-in per agent. Reminders persist on disk and fire later on the same surface that scheduled them. See [Reminders](../concepts/starting-runs.md).

For CLI-hosted agents, `add_reminder` installs the same real one-shot host-scheduler job
(`launchd` on macOS, an `at` job on Linux) used for wake triggers, so a reminder fires even if
`jazz daemon` isn't running; firing sends a native OS desktop notification instead of resuming a
conversation: a reminder is "notify a person," never "resume the agent." `jazz daemon`'s
in-process ticker remains a fallback for hosts with neither `launchd` nor `at`. Telegram and
Discord reminders are unaffected by any of this: their bots already sweep and deliver reminders
as chat messages from their own in-process interval, unchanged.

| Tool              | Risk        | Approval pair | What it does                                                                                                                                     |
| ----------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `add_reminder`    | `low-risk`  | none          | Schedule a reminder from a duration (`30m`), clock time (`18:00`), `tomorrow HH:MM`, a weekday (`tue 20:00`), or an absolute `2026-08-25 20:00`. |
| `list_reminders`  | `read-only` | none          | List this person's pending reminders, including their id, fire time, and text.                                                                   |
| `cancel_reminder` | `low-risk`  | none          | Cancel a pending reminder by id (get the id from list_reminders first).                                                                          |

### Goals and loops

The agent proposes a goal when a request needs sustained work across several runs. The goal is
saved as `proposed` and nothing runs until the user accepts the plan: chat asks right after the
turn, and `jazz goal accept <id>` accepts it elsewhere. Subagents and goal cycles cannot propose
goals. A goal's own cycles get `report_goal_cycle`, which says where the goal stands (Jazz checks
the claim against the cycle's tool output), and a loop's own runs get `end_loop`, which stops the
loop after the run; nothing else has either, and no tool can start a loop. See [Goals and loops](../concepts/goals-and-loops.md) and
[`jazz loop`](../commands.md#jazz-loop).

| Tool                | Risk       | Approval pair | What it does                                                                                                                                                |
| ------------------- | ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose_goal`      | `low-risk` | none          | Propose a plan (objective, observable criteria, milestones) for work that must continue over time. Only in interactive chat and `jazz run --propose-goals`. |
| `end_loop`          | `low-risk` | none          | End the loop the run belongs to, with the reason shown to the user. Only in runs a loop started.                                                            |
| `report_goal_cycle` | `low-risk` | none          | Report the goal's status at the end of a cycle: continue, complete (with evidence quoted from tool output), blocked, or a question. Only in goal cycles.    |

### Wake Triggers

Opt-in per agent. A trigger causes the agent to actually run again with a given prompt, resuming
the exact conversation it was scheduled from: unlike a reminder, which just delivers a note to a
person. See [Reminders](../concepts/starting-runs.md) for how the two compare.

`register_trigger` does not depend on `jazz daemon` running to actually fire. Registering a
trigger installs a real one-shot job with the host's own scheduler: a `launchd` job on macOS, an
`at` job on Linux: that fires the trigger by invoking `jazz` directly at the scheduled time, even
if nothing else is running. `jazz daemon`'s in-process ticker remains a fallback for platforms or
environments with neither `launchd` nor the `at` binary available (most containers, some CI), and
scheduling with the host is always best-effort: if it fails for any reason, registration still
succeeds and the ticker is the safety net.

| Tool               | Risk        | Approval pair | What it does                                                                                      |
| ------------------ | ----------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `register_trigger` | `low-risk`  | none          | Schedule yourself to wake up later and resume this exact conversation. Use this when you need to… |
| `list_triggers`    | `read-only` | none          | List this agent's pending self-scheduled wake triggers.                                           |
| `cancel_trigger`   | `low-risk`  | none          | Cancel a pending wake trigger by id (get the id from list_triggers first).                        |

### Background Jobs

Background-job tools are in the built-in bundle. `enqueue_batch` starts independent shell
commands in a detached worker, with bounded concurrency and retries. When all jobs finish,
the agent resumes its conversation with their statuses and output.

No daemon is required to start a batch. The daemon can recover a batch whose worker stopped.
If the resumed turn needs approval, it parks and sends a notification; answer with
`jazz runs approve <id>`. See [Deferred work](../concepts/deferred-work.md).

| Tool            | Risk        | Approval pair           | What it does                                                                                               |
| --------------- | ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `enqueue_batch` | `unknown`   | `execute_enqueue_batch` | Run several independent shell commands in the background with a concurrency cap and per-job retry/backoff. |
| `list_jobs`     | `read-only` | none                    | List this agent's background job batches, every job's status, and what each one printed.                   |
| `cancel_batch`  | `low-risk`  | none                    | Cancel a job batch's pending jobs by id (jobs already running finish naturally).                           |

### Context

| Tool                   | Risk        | Approval pair | What it does                                                                                            |
| ---------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `context_info`         | `read-only` | none          | Get current context window token usage statistics.                                                      |
| `get_time`             | `read-only` | none          | Get current date and time. Use for scheduling, relative times (yesterday, next Monday), and timestamps. |
| `retrieve_tool_result` | `read-only` | none          | Read a tool body that was offloaded from context. Pass the `tool_call_id` from the placeholder.         |

### Tool Search

| Tool           | Risk        | Approval pair | What it does                                                                                                                                        |
| -------------- | ----------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_tools` | `read-only` | none          | Fetch full parameter schemas for deferred tools (MCP servers, background jobs, etc.) you can see by name in your tool list but haven't fetched yet. |

### Sub Agents

| Tool                | Risk        | Approval pair | What it does                                                                                                                                                                                                                            |
| ------------------- | ----------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn_subagent`    | `read-only` | none          | Spawn a sub-agent with fresh context for a specific task. Personas: coder, researcher, default. Returns an `agentId` at once; collect the answer with `wait_subagents`. Optionally validate a bounded JSON handoff with `resultSchema`. |
| `list_subagents`    | `read-only` | none          | Show each sub-agent of the run: status, current activity, spend so far and its result once finished.                                                                                                                                    |
| `wait_subagents`    | `read-only` | none          | Wait for sub-agents (until any or all) and return their results in one call.                                                                                                                                                            |
| `steer_subagent`    | `read-only` | none          | Message, pause, resume or cancel a running sub-agent. Messages and pauses take effect before its next model call.                                                                                                                       |
| `summarize_context` | `read-only` | none          | Compact conversation by summarizing older messages to free token budget. Always performs summarization when…                                                                                                                            |

### Perception Delegation

Always-on. Lets an agent borrow specialist perception or generation from another model.

| Tool             | Risk        | Approval pair            | What it does                                                                                                                                                                                                  |
| ---------------- | ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze_media`  | `high-risk` | `execute_analyze_media`  | Delegate image/audio/video analysis to a capable companion and return its textual answer. The person at the keyboard picks the model; a pre-bound `analyze:*` companion routes there without a picker.        |
| `generate_media` | `high-risk` | `execute_generate_media` | Delegate image/audio/video generation to a capable companion and return its files as artifacts. The person at the keyboard picks the model; a pre-bound `generate:*` companion routes there without a picker. |

### User Interaction

| Tool                | Risk        | Approval pair | What it does                                                                                                              |
| ------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ask_file_picker`   | `read-only` | none          | Show an interactive file picker for the user to select a file.                                                            |
| `ask_user_question` | `read-only` | none          | Ask the user a question with interactive selectable suggestions. One question per call.                                   |
| `ask_user_secret`   | `read-only` | none          | Ask the user to type a password, token or passphrase, hidden. Returns a `[redacted:<name>]` placeholder, never the value. |

### Compositions

Enable [Compositions](../concepts/compositions.md) per agent to create interactive HTML pages
or static images. The bundled `composition` skill supplies design instructions.

| Tool                 | Risk        | Approval pair | What it does                                                                                                                                                 |
| -------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_composition` | `low-risk`  | none          | Compose a polished visualization, interactive explainer, dashboard, form, or small tool as a static image or live HTML artifact.                             |
| `create_pdf`         | `high-risk` | none          | Render a PDF from HTML the agent writes, saved to the working directory or an explicit path. Text and numbers are exact: a renderer, not an image generator. |

### Browser

Enable [Browser Use](../concepts/browser-use.md) per agent to drive real web pages. The tools load on
demand and are off by default.

| Tool                 | Risk        | Approval pair         | What it does                                                                                                                             |
| -------------------- | ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_navigate`   | `low-risk`  | none                  | Open an http(s) URL in the run's browser and return its URL and title.                                                                   |
| `browser_back`       | `low-risk`  | none                  | Go back one page in the browser's history.                                                                                               |
| `browser_snapshot`   | `read-only` | none                  | Read the current page as a text outline with a ref on every interactive element.                                                         |
| `browser_screenshot` | `low-risk`  | none                  | Save a PNG of the current page and return its path for `analyze_media`.                                                                  |
| `browser_tabs`       | `low-risk`  | none                  | List, switch between, and close the run's named tabs. `list` is `read-only`. Open a new tab by giving `browser_navigate` a new tab name. |
| `browser_act`        | `high-risk` | `execute_browser_act` | Click, type, choose an option, or press a key. Typed secrets from `ask_user_secret` are entered only after you approve, on https pages.  |
| `browser_close`      | `read-only` | none                  | Close the browser and discard its cookies and session.                                                                                   |

`browser_adopt_tab` (`high-risk`, pair `execute_browser_adopt_tab`) is registered only when
`browser.endpoint` points at a browser the user runs: it lets the agent take over one
existing tab the user names, after a separate approval showing the tab's title and URL. The
agent sees only tabs it created or adopted, never the rest of the user's browser.

### Computer use (experimental)

Enable [Computer use](../concepts/computer-use.md) per agent to look at and act in desktop apps
you grant. It is experimental, runs on macOS with Apple Silicon only, and exists only in a
terminal conversation with you watching. The tools load on demand and are off by default.

| Tool                  | Risk        | Approval pair                 | What it does                                                                                                     |
| --------------------- | ----------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `computer_apps`       | `read-only` | none                          | List the apps you granted, what each allows, and their visible windows.                                          |
| `computer_observe`    | `read-only` | none                          | Read one window of a granted app as a text outline with refs, and optionally save a screenshot.                  |
| `computer_pointer`    | `low-risk`  | `execute_computer_pointer`    | Click an element or pixel, or scroll, in the background without moving your cursor.                              |
| `computer_wait`       | `read-only` | none                          | Wait until the last observed window settles or changes, then return a fresh observation. No action is performed. |
| `computer_input`      | `high-risk` | `execute_computer_input`      | Type into an element or press a named key or shortcut. A typed secret is entered only after you approve.         |
| `computer_foreground` | `high-risk` | `execute_computer_foreground` | Bring a granted app to the front, then click, scroll, type or press a key. The app needs a foreground grant.     |
| `computer_handoff`    | `low-risk`  | `execute_computer_handoff`    | Pause and ask you to do a step yourself, such as signing in. Always asks, and clears every earlier observation.  |
| `computer_end`        | `read-only` | none                          | Stop using the computer: close the driver, delete this run's screenshots, and release the desktop.               |

---

## What is _not_ a built-in tool

A common and consequential misreading. These capabilities exist, but **not as built-in
tools**: they are [skills](../concepts/skills.md) that shell out through
`execute_command`, which is `unknown`:

| Capability                  | How it actually works                                                                      | Effective risk tier     |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| Email (read, archive, send) | `email` skill → [Himalaya](https://github.com/pimalaya/himalaya) CLI via `execute_command` | `unknown`               |
| Calendar (list, create)     | `calendar` skill → [khal](https://github.com/pimutils/khal) via `execute_command`          | `unknown`               |
| Obsidian vault writes       | `obsidian` skill → CLI via `execute_command`, or `write_file`                              | `unknown` / `high-risk` |

Jazz classifies each CLI command before applying the run's approval policy. Read-only
commands may run at `read-only`; mailbox or calendar changes can require human approval.
Grant specific commands only when you understand their scope. A grant for an entire binary
such as `himalaya` also permits its mutation commands.
See [email and calendar setup](../configure/email-calendar.md).

---

## Notes

- **Editing a file another agent may change**: Pass the `snapshot` from a text `read_file` unchanged to `edit_file`, even if you read only a line range. A stale snapshot returns `StaleFileError` without writing or asking for approval; read again and retry. Append reads and media attachments do not produce snapshots. Jazz serializes its own edits; writes from other programs can still conflict.
- **Following a file that is still being written**: `read_file` with `sinceByte` returns appended bytes, plus `nextByte` and `inode` for the next read. On truncation or rotation it restarts at byte 0 and reports the change. A nonzero `sinceByte` cannot be combined with `startLine` or `endLine`.
- **`find` vs `grep`**: `find` locates files by name, glob, or path pattern. `grep` searches _inside_ file contents.
- **Shell command approval**: Jazz classifies each command as `read-only`, `low-risk`, or `high-risk`, then applies the active approval policy. Interactive chat shows the classification while it runs and the result afterwards. Timeouts and ambiguous classifications remain `high-risk`. See [Approvals](../security/approvals.md).
- **HTTP requests and page fetches run automatically by default.** `http_request` and `web_fetch` have the same global `network.httpApproval` policy, independent of method, risk tier, private destinations, prior untrusted content, or unattended execution. A configured URL array requires one-call approval outside its grants; approving never changes the list. Each redirect must match a grant too. Both tools strip credential/custom headers across origins, refuse forwarding bodies across origins, and cap response bytes and read time. `web_fetch` extracts page content as markdown; `http_request` preserves API response structure and supports methods, headers and bodies. See [HTTP approvals](../configure/jazz.md#web-request-safety).
- **Other model-chosen URLs use private-destination guards.** `read_pdf` with a URL and rendered pages resolve each hostname, check every redirect, and require approval for unlisted private addresses. Approving adds those addresses to global `network.allowPrivateHosts`. The same credential and body limits apply. See [Secrets and egress](../security/secrets-and-egress.md#network-egress).
- **Secret values never reach the model.** Files read normally, including `.env` and `secrets.json`. Every tool result is redacted before it is logged or shown: secrets Jazz holds (keyring-held peer, webhook and notify secrets included) and credential-named environment variables are replaced exactly; `.env` and YAML assignments, key formats, JWTs, webhook URLs and private keys by shape; and strings under secret-named keys in structured results, each as `[redacted:<name>]`. Tools redact before they cut or search: `read_file` line ranges, `sinceByte` offsets and caps, `execute_command` output caps, and `grep` and `replace_pattern` matching all work on the redacted text, so no slice splits a secret and no pattern can probe one. `write_file` and `edit_file` refuse a placeholder standing for a secret of the target file or one Jazz knows, and `write_file` refuses to drop a line holding a secret; change such files with `edit_file` around the placeholder lines. See [Secrets and egress](../security/secrets-and-egress.md#secret-values-in-tool-output).
- **Secrets the person types stay out of the model.** `ask_user_secret` reads the value hidden and gives the model `[redacted:<name>]`. The value is held in memory for the rest of the run, redacted exactly from every tool result and log line, and put back only into the arguments a tool declares for it, just before that tool runs: `password` of `read_pdf` and `pdf_page_count`, and `command` of `execute_command`, which then always asks a person, whose approval shows the placeholder. Any other tool or argument carrying the placeholder is refused. See [Secrets the person types](../security/secrets-and-egress.md#secrets-the-person-types).
- **Jazz's own config always asks.** `write_file`, `edit_file`, `mv`, `cp` and `rm` changing `config.json` or Jazz's state under `$JAZZ_HOME` ask for approval under every policy, `yolo` included. Authored content (`skills`, `workflows`, `personas`, `memory`, `workspace` and generated output) follows the ordinary policy.
- **Outside content arrives labelled.** Results from `web_fetch`, `web_search`, `http_request`, `read_pdf` URLs, MCP tools, `ask_peer`, every `execute_command` and custom command, and `read_file` of a file outside the working directory come back inside an `<untrusted-content>` envelope that names the source, and the system prompt tells the model to read them as data. Once a run has read external content, other egress tools stop auto-approving below `high-risk`. Because Jazz cannot tell what a command read, that includes any shell command: after one, other egress at `read-only` or `low-risk` needs approval. See [Unattended runs](../security/unattended-runs.md#egress-after-untrusted-input).
- **Timeouts**: 3 minutes by default per tool. Questions, secret prompts, and file pickers wait without a timeout. `execute_command` and `wait_for` accept at most 15 minutes; larger timeouts are rejected.
- **Stopping a command**: `execute_command` and custom command tools run in their own process group. Esc, a tool timeout, `--timeout`, SIGTERM, or a run's `maxDurationMs` deadline stops the command together with every process it started: SIGTERM first, and SIGKILL 3 seconds later if it is still running, so a command can finish writing and clean up. `write_file`, `edit_file`, `cp` and `mv` replace their target in one step, so a stopped call leaves the old version or the new one, never half a file. The tool results then say which calls completed, which were interrupted, and which never started. A command that leaves a job running in the background (`server &`) returns as soon as the shell exits, and the job keeps running.
- **Concurrency**: up to 10 tools execute in parallel per iteration.
- **PDF rendering**: `create_pdf` requires Chrome. Output goes to the working directory unless an explicit `path` overrides it.
- **Composition rendering**: `mode: "static"` requires Google Chrome or `PUPPETEER_EXECUTABLE_PATH`; `mode: "interactive"` needs no browser. Compositions live under `~/.jazz/compositions/<session-id>/`. Jazz opens a completed composition automatically only in an interactive local terminal.

---

## Related

- [Approvals](../security/approvals.md): what runs without asking
- [Concepts: tools](../concepts/tools.md): what a tool is and how to add one
- [Commands and flags](../commands.md): `--approval-policy` and friends
- [Agent configuration](../configure/agents.md): `customTools`, `envAllowlist`, and per-agent denials
- [Jazz configuration](../configure/jazz.md): runtime defaults and `autoApprovedCommands`
