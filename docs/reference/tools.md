---
description: "The complete Jazz tool registry — every tool name, its honest risk tier, and exactly what stands between a tool call and an action on your machine."
---

# Tools Reference

This page helps you find the exact name, risk tier, and behavior of a tool.

Every tool an agent can call, generated from the registry. Risk tiers determine what runs
unattended — see [Tools & approval](../internals/tools-and-approval.md) for the mechanism
and [Security](../../SECURITY.md) for the threat model.

> This page is verified by a test (`bun test packages/core/src/agent/tools/register-tools.docs.test.ts`)
> that fails if the registry and this table drift apart. If you add a tool, update this page.

---

## At a glance

|                                                                         | Count  |
| ----------------------------------------------------------------------- | ------ |
| **Agent-facing tools**                                                  | **41** |
| Hidden `execute_*` counterparts (the second half of each approval pair) | 8      |
| Total registered                                                        | 50     |
| `read-only`                                                             | 22     |
| `low-risk`                                                              | 11     |
| `high-risk`                                                             | 7      |
| `unknown`                                                               | 1      |

Plus, registered per agent rather than globally:

| Source     | Tools                                             | Notes                                                                                              |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Skills** | `find_skills`, `load_skill`, `load_skill_section` | Present when the agent has skills available — see [Skills loading](../internals/skills-loading.md) |
| **MCP**    | `mcp_<server>_<tool>`                             | Discovered from the agent's tool list, connected lazily — see [MCP](../integrations/mcp.md)        |
| **Custom** | whatever you define                               | Agent-config `customTools` — see [Configuration](./configuration.md#agent-config-customtools)      |

---

## How approval pairs work

Seven tools are **gated**: calling them does not act. They return a description of the
intended action (including a preview diff for edits), and only after approval — from a human
or from `--approval-policy` — does Jazz invoke the hidden `execute_*` counterpart.

```mermaid
flowchart LR
    M["Model calls<br/><code>write_file</code>"] --> P["Propose:<br/>resolve path, compute diff<br/><b>no mutation</b>"]
    P --> G{"Approved?"}
    G -->|yes| E["<code>execute_write_file</code><br/>actually writes"]
    G -->|no| D["Refusal returned<br/>to the agent"]

    classDef gate fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    classDef act fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    class G gate
    class E act
```

You never call `execute_*` names yourself; they are hidden from the model's tool list.

---

## What each tool reveals

Risk is not the same question as disclosure. Risk asks what a tool can do **to** the
machine; disclosure asks how freely its answer can be shared. The two do not correlate:
`read_file` is read-only and can reveal anything, `get_time` is read-only and reveals
nothing, `write_file` changes the machine and reveals nothing at all.

Every tool declares both. The field is required, with no default anywhere, so a new tool
cannot be added without someone deciding.

| Level      | Safe to tell                                                    | Tools                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`   | safe to tell anyone                                             | `add_reminder`, `cp`, `mkdir`, `mv`, `rm`, `web_fetch`, `web_search`, `write_file`                                                                                                                                                                                                                                     |
| `internal` | the shape of this machine — paths, names, what is installed     | `analyze_media`, `cancel_trigger`, `cd`, `context_info`, `create_pdf`, `create_web_app`, `find`, `get_time`, `list_triggers`, `ls`, `pdf_page_count`, `pwd`, `register_trigger`, `stat`                                                                                                                               |
| `private`  | your own material — file contents, memory, schedule, transcript | `ask_file_picker`, `ask_user_question`, `cancel_reminder`, `edit_file`, `execute_command`, `grep`, `http_request`, `list_reminders`, `list_todos`, `manage_memory`, `manage_todos`, `manage_workspace`, `read_file`, `read_pdf`, `spawn_subagent`, `summarize_context`, `update_work_state`, `view_memory`, `view_workspace` |

A tool spanning two levels takes the more sensitive one — `edit_file` writes, but its approval
message carries a diff of your file, so it is `private`. `http_request` reaches private
networks including services on localhost, so it is too.

Skill tools (`find_skills`, `load_skill`, `load_skill_section`) are `internal` too, and are
absent from the table for the same reason they are absent from the one below: they are
registered per agent rather than globally.

There is no `unknown` level. **MCP and custom tools are `private`**, because a tool defined
outside this codebase returns something this codebase cannot classify, and the safe reading
of "unknown" is the most restrictive one.

---

## The tools

### File Management

| Tool             | Risk        | Approval pair        | What it does                                                                                                              |
| ---------------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cd`             | `read-only` | —                    | Change the working directory for this session. Persists across subsequent tool calls.                                     |
| `cp`             | `high-risk` | `execute_cp`         | Copy a file or directory. Equivalent to shell cp/cp -r. Directories are copied recursively.                               |
| `edit_file`      | `high-risk` | `execute_edit_file`  | Edit file via replace_lines, replace_pattern, insert, or delete_lines. Applied in order. IMPORTANT: Use rep…              |
| `find`           | `read-only` | —                    | Find files/directories by name, glob, or regex. Also advertised as `glob`. Searches names/paths, NOT contents (use grep). |
| `grep`           | `read-only` | —                    | Search file contents for text patterns (ripgrep with grep fallback). Supports regex, file filters, context…               |
| `ls`             | `read-only` | —                    | List directory contents. Supports recursive traversal, name filtering, hidden files. Default 200 results, c…              |
| `mkdir`          | `high-risk` | `execute_mkdir`      | Create a directory. Parents created automatically by default.                                                             |
| `mv`             | `high-risk` | `execute_mv`         | Move or rename a file or directory. Equivalent to shell mv.                                                               |
| `pdf_page_count` | `read-only` | —                    | Get total page count of a PDF without reading content.                                                                    |
| `pwd`            | `read-only` | —                    | Print the current working directory.                                                                                      |
| `read_file`      | `read-only` | —                    | Read a UTF-8 text file with numbered lines. startLine/endLine; negative startLine reads from the end.                     |
| `read_pdf`       | `read-only` | —                    | Extract text and tables from a PDF. Use pdf_page_count first for large files. Supports page ranges.                       |
| `rm`             | `high-risk` | `execute_rm`         | Remove a file or directory. May be irreversible.                                                                          |
| `stat`           | `read-only` | —                    | Check file/directory existence and get metadata (type, size, times).                                                      |
| `write_file`     | `high-risk` | `execute_write_file` | Write content to a file, creating it if needed. Replaces entire file content.                                             |

### Shell Commands

| Tool              | Risk      | Approval pair             | What it does                                                                                                                                                                                                  |
| ----------------- | --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute_command` | `unknown` | `execute_execute_command` | Run a shell command when no dedicated tool exists. Each command is classified `read-only`, `low-risk`, or `high-risk`, and the active tier then applies to that verdict. Stdout/stderr capped at 256 KB each. |

In the interactive terminal, an operator can also type `! <command>`. That explicit shell escape
uses the same cwd resolution, environment sanitization, denylist, timeout, interruption, and
output caps as `execute_command`, then gives the result to the agent as context. It is not
available through `jazz run` or remote chat surfaces.

### Web Search

| Tool         | Risk        | Approval pair | What it does                              |
| ------------ | ----------- | ------------- | ----------------------------------------- |
| `web_search` | `read-only` | —             | Search the web for real-time information. |

### Web Fetch

| Tool        | Risk        | Approval pair | What it does                               |
| ----------- | ----------- | ------------- | ------------------------------------------ |
| `web_fetch` | `read-only` | —             | Fetch and extract text content from a URL. |

### HTTP

| Tool           | Risk        | Approval pair | What it does                                                                       |
| -------------- | ----------- | ------------- | ---------------------------------------------------------------------------------- |
| `http_request` | `read-only` | —             | Send HTTP requests. Supports all methods, headers, query params, and body formats. |

### Todo

| Tool                | Risk        | Approval pair | What it does                                                                                                 |
| ------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `list_todos`        | `read-only` | —             | Read the current todo list. Returns all items with their status and priority.                                |
| `manage_todos`      | `low-risk`  | —             | Create or update the todo list. Send the FULL list of items each time (replaces the previous list). Use thi… |
| `update_work_state` | `low-risk`  | —             | Record where you are in the current task so it survives compaction and resuming later. Patches o…            |

### Memory

Opt-in per agent (like File Management) rather than always-on — see [Memory](../internals/memory.md).

| Tool            | Risk        | Approval pair | What it does                                                                                      |
| --------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `view_memory`   | `read-only` | —             | Call first, before answering, at the start of every conversation.                                 |
| `manage_memory` | `low-risk`  | —             | Save facts about this person that will still matter later — preferences, location, age, how they… |

`update_work_state` lives with the todo tools (always-on). It is scoped to one conversation and discarded when the task ends, unlike memory which persists across conversations — see [Context management](../internals/context-management.md).

### Workspace

Opt-in per agent (like Memory) rather than always-on. Deliberately separate from memory: memory
is small, curated, one-file-per-topic notes; workspace is where large working drafts, research
dumps, and intermediate artifacts live, referenced from memory rather than duplicated into it.

| Tool               | Risk        | Approval pair | What it does                                                                                       |
| ------------------- | ----------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `view_workspace`   | `read-only` | —             | View your durable scratch space: working drafts, research dumps, and intermediate artifacts too…  |
| `manage_workspace` | `low-risk`  | —             | Save durable working drafts, research dumps, or intermediate artifacts too large or provisional…  |

### Reminders

Opt-in per agent. Reminders persist on disk and fire later on the same surface that scheduled them — see [Reminders](../internals/reminders.md).

| Tool              | Risk        | Approval pair | What it does                                                                                                                                     |
| ----------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `add_reminder`    | `low-risk`  | —             | Schedule a reminder from a duration (`30m`), clock time (`18:00`), `tomorrow HH:MM`, a weekday (`tue 20:00`), or an absolute `2026-08-25 20:00`. |
| `list_reminders`  | `read-only` | —             | List this person's pending reminders, including their id, fire time, and text.                                                                   |
| `cancel_reminder` | `low-risk`  | —             | Cancel a pending reminder by id (get the id from list_reminders first).                                                                          |

### Wake Triggers

Opt-in per agent. A trigger causes the agent to actually run again with a given prompt, resuming
the exact conversation it was scheduled from — unlike a reminder, which just delivers a note to a
person. See [Reminders](../internals/reminders.md) for how the two compare.

| Tool                | Risk        | Approval pair | What it does                                                                                       |
| -------------------- | ----------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `register_trigger` | `low-risk`  | —             | Schedule yourself to wake up later and resume this exact conversation — use this when you need to… |
| `list_triggers`     | `read-only` | —             | List this agent's pending self-scheduled wake triggers.                                            |
| `cancel_trigger`    | `low-risk`  | —             | Cancel a pending wake trigger by id (get the id from list_triggers first).                          |

### Context

| Tool           | Risk        | Approval pair | What it does                                                                                            |
| -------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `context_info` | `read-only` | —             | Get current context window token usage statistics.                                                      |
| `get_time`     | `read-only` | —             | Get current date and time. Use for scheduling, relative times (yesterday, next Monday), and timestamps. |

### Sub Agents

| Tool                | Risk        | Approval pair | What it does                                                                                                 |
| ------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `spawn_subagent`    | `low-risk`  | —             | Spawn a sub-agent with fresh context for a specific task. Personas: coder, researcher, default. Pass a shor… |
| `summarize_context` | `read-only` | —             | Compact conversation by summarizing older messages to free token budget. Always performs summarization when… |

### Perception Delegation

Always-on. Lets a text-only agent borrow eyes, ears, or a watch from a model that has them.

| Tool                        | Risk        | Approval pair          | What it does                                                                                                 |
| --------------------------- | ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `analyze_media`             | `high-risk` | `execute_analyze_media` | Delegate image/audio/video analysis to a capable model companion and get the textual answer back. The person at the keyboard picks which model does the looking (picker-style approval, never auto-approved); an agent with a pre-bound `companions` entry for the modality routes there silently instead. |

### User Interaction

| Tool                | Risk        | Approval pair | What it does                                                                            |
| ------------------- | ----------- | ------------- | --------------------------------------------------------------------------------------- |
| `ask_file_picker`   | `read-only` | —             | Show an interactive file picker for the user to select a file.                          |
| `ask_user_question` | `read-only` | —             | Ask the user a question with interactive selectable suggestions. One question per call. |

### Web App

Opt-in per agent via `tools`. Used by chat bridges that can render a Mini App or a static image.

| Tool             | Risk       | Approval pair | What it does                                                                                                                                                  |
| ---------------- | ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_web_app` | `low-risk` | —             | Create an interactive UI — a chart, form, dashboard, small game, or any other webpage — for delivery as a static image or a live page.                        |
| `create_pdf`     | `low-risk` | —             | Render a PDF from HTML the agent writes, saved to the working directory or an explicit path. Text and numbers are exact — a renderer, not an image generator. |

---

## What is _not_ a built-in tool

A common and consequential misreading. These capabilities exist, but **not as built-in
tools** — they are [skills](../concepts/skills.md) that shell out through
`execute_command`, which is `unknown`:

| Capability                  | How it actually works                                                                      | Effective risk tier     |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| Email (read, archive, send) | `email` skill → [Himalaya](https://github.com/pimalaya/himalaya) CLI via `execute_command` | `unknown`               |
| Calendar (list, create)     | `calendar` skill → [khal](https://github.com/pimutils/khal) via `execute_command`          | `unknown`               |
| Obsidian vault writes       | `obsidian` skill → CLI via `execute_command`, or `write_file`                              | `unknown` / `high-risk` |

So a scheduled workflow set to `autoApprove: low-risk` **cannot archive an email** — every
himalaya invocation is declined. The fix is usually _not_ to raise the whole tier to
`high-risk` (which also unlocks `rm` and `git push`), but to allowlist the specific binary:

```json
// ~/.jazz/config.json
{ "autoApprovedCommands": ["himalaya", "khal"] }
```

That keeps the tier low while letting the one command through. Matching is on a parsed key
(binary + first subcommand), never a raw prefix — see
[Tools & approval](../internals/tools-and-approval.md#two-sharper-controls).

---

## Notes

- **`find` vs `grep`** — `find` locates files by name, glob, or path pattern. `grep` searches _inside_ file contents. Non-overlapping on purpose.
- **`execute_command` classifier**. The tool is `unknown`, so a harness-model classifier labels each command `read-only`, `low-risk`, or `high-risk` and the active tier judges that verdict: `--approval-policy read-only` auto-approves an inspect-only command, an interactive session skips its prompt, yolo skips the classifier entirely. The live zone shows `classifying` while it runs, and the verdict is printed on the settled receipt. It sees the last five _user_ requests (800 characters) on an interactive session and the command alone everywhere else — never the assistant's own turns. Timeouts and ambiguous replies stay `high-risk`. See [Tools & approval](../internals/tools-and-approval.md#command-classifier).
- **`http_request` is `read-only`** by risk classification even though it can issue POSTs. It reaches whatever URL the agent targets; network policy belongs at the firewall, not the tier. Treat it accordingly on surfaces that accept untrusted input.
- **Timeouts** — 3 minutes by default per tool. `ask_user_question` and `ask_file_picker` are `longRunning` and never time out, because waiting for a human is not a hang.
- **Concurrency** — up to 10 tools execute in parallel per iteration.
- **`create_pdf` needs a browser too** — same `puppeteer-core` path as `create_web_app`'s static mode, rendering through `page.pdf()`. It writes to the agent's working directory by default (an explicit `path` overrides), unlike `create_web_app`, whose output lands in Jazz's own data directory because only a bridge ever reads it.
- **`create_web_app` needs a browser for `mode: "static"`** — it screenshots the page through `puppeteer-core`, which deliberately ships no bundled Chrome so that installing Jazz never downloads one. It uses `PUPPETEER_EXECUTABLE_PATH` if set, otherwise an installed Google Chrome; with neither it fails and says so. `mode: "interactive"` needs no browser.

---

## Related

- [Tools & approval](../internals/tools-and-approval.md) — the execution and gating machinery
- [Concepts: tools](../concepts/tools.md) — what a tool is and how to add one
- [CLI Reference](./cli.md) — `--approval-policy` and friends
- [Configuration](./configuration.md) — `customTools`, `envAllowlist`, `autoApprovedCommands`
