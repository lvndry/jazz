---
description: "Generated catalog of every built-in Jazz tool with its group, load tier, risk level, parameters and an estimated token cost, checked against the registry in CI."
---

# Built-in tool catalog

Generated from the tool registry by `scripts/gen-tool-catalog.ts`. Do not edit by hand: run
`bun run docs:tool-catalog` after adding, renaming or rewording a tool or changing a parameter, and
commit the result. `bun run docs:tool-catalog:check` fails when this page is stale.

Token counts are estimates: characters divided by 4, rounded up. They are for comparing tools in
review, not for billing. **Schema tokens** is the full definition (name, description and
parameter JSON Schema). **Always-on tokens** is what each request pays for the tool whenever a run
holds it: the full definition in an `eager` group, the name and one-line summary in a
`deferred` one. A parameter ending in `*` is required. A hidden `execute_*` tool is the second
half of an approval pair and is never sent to a model. For what each risk level allows, see
[tool inventory](../tools/index.md) and [tool lifecycle](./tool-lifecycle.md).

**Registered** is when the tool exists: `startup` for every run, `per run` for a tool the
agent runner registers at the start of each run, and `per run, when ...` for one that exists only
under that condition. The generator calls the same registration functions the runner calls and
supplies a placeholder peer so the peer tools appear.

Not listed: MCP server tools, plugin tools and `customTools` from agent configs, which come from
configuration; and the skill tools' skill-name constraint, which depends on the skills installed.

## Groups

| Group | Tier | Tools | Always-on tokens |
| --- | --- | ---: | ---: |
| Background Jobs | deferred | 4 | 127 |
| Browser Use | deferred | 10 | 169 |
| Compositions | deferred | 3 | 88 |
| Computer use (experimental) | deferred | 18 | 292 |
| Context | eager | 3 | 275 |
| File Management | eager | 21 | 3224 |
| Goals and loops | eager | 3 | 1115 |
| HTTP | eager | 1 | 535 |
| Memory | eager | 3 | 1673 |
| Memory curation | eager | 1 | 343 |
| Peers | deferred | 2 | 58 |
| Perception Delegation | eager | 4 | 277 |
| Reminders | deferred | 3 | 78 |
| Scratchpad | eager | 3 | 862 |
| Shell Commands | eager | 5 | 764 |
| Skills | eager | 3 | 318 |
| Sub Agents | eager | 8 | 2039 |
| Todo | eager | 3 | 540 |
| Tool Search | eager | 1 | 109 |
| User Interaction | eager | 6 | 915 |
| Wake Triggers | deferred | 3 | 124 |
| Web Fetch | eager | 1 | 157 |
| Web Search | eager | 1 | 321 |

## Tools

| Tool | Group | Tier | Registered | Risk | Parameters | Schema tokens | Always-on tokens | Summary |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| `cancel_background_jobs` | Background Jobs | deferred | startup | `low-risk` | `batchId*` | 82 | 27 | Cancel a job batch's pending jobs by id (get the id from list_background_jobs first). |
| `execute_run_background_jobs` | Background Jobs (hidden) | deferred | startup | `unknown` | `concurrencyCap`, `jobs*`, `maxAttempts`, `reason*` | 0 | 0 | Runs the action `run_background_jobs` proposed. |
| `list_background_jobs` | Background Jobs | deferred | startup | `read-only` | `batchId` | 81 | 33 | Check on background jobs already started: each batch's progress, every job's status, and the output it printed. |
| `run_background_jobs` | Background Jobs | deferred | startup | `unknown` | `concurrencyCap`, `jobs*`, `maxAttempts`, `reason*` | 327 | 67 | Run shell commands in the background and get woken with what they printed — monitor or watch something until it finishes, poll a log, a page, a price or a repo for changes, run the same check across several targets. Each job is capped at 15 minutes. |
| `browser_act` | Browser Use | deferred | startup | `high-risk` | `actions*` | 406 | 21 | Click, type into, select from or press keys on a web page in the browser. |
| `browser_adopt_tab` | Browser Use | deferred | per run | `high-risk` | `match*`, `name*` | 177 | 24 | Ask the person to share one tab they already have open in their own browser. |
| `browser_back` | Browser Use | deferred | startup | `low-risk` |  | 54 | 14 | Go back to the previous page in the browser. |
| `browser_close` | Browser Use | deferred | startup | `read-only` |  | 58 | 17 | Close the browser and discard its cookies and logins. |
| `browser_navigate` | Browser Use | deferred | startup | `low-risk` | `tab`, `url*` | 180 | 29 | Open a web page in a real browser: browse sites, log in, fill forms, use pages that need JavaScript. |
| `browser_screenshot` | Browser Use | deferred | startup | `low-risk` | `fullPage` | 91 | 20 | Save a screenshot of the current web page as an image file. |
| `browser_snapshot` | Browser Use | deferred | startup | `read-only` | `startLine` | 153 | 25 | Read the current web page as a text outline with refs for links, buttons and fields. |
| `browser_tabs` | Browser Use | deferred | startup | `low-risk` | `action*`, `name` | 146 | 19 | List, switch between, and close the named tabs of the browser. |
| `execute_browser_act` | Browser Use (hidden) | deferred | startup | `high-risk` | `actions*` | 0 | 0 | Runs the action `browser_act` proposed. |
| `execute_browser_adopt_tab` | Browser Use (hidden) | deferred | per run | `high-risk` | `match*`, `name*` | 0 | 0 | Runs the action `browser_adopt_tab` proposed. |
| `create_composition` | Compositions | deferred | startup | `low-risk` | `height`, `html`, `htmlPath`, `mode*`, `title*`, `width` | 539 | 31 | Compose a visual artifact: chart, visualization, diagram, interactive explainer, dashboard, form or tool. |
| `create_pdf` | Compositions | deferred | startup | `high-risk` | `format`, `html*`, `landscape`, `path`, `title*` | 225 | 27 | Render a PDF from HTML you write, saved to the working directory: reports, invoices, documents. |
| `publish_composition` | Compositions | deferred | startup | `high-risk` | `host`, `htmlPath*`, `repo`, `visibility` | 491 | 30 | Publish a composition HTML file to a stable public or private URL (GitHub Pages or Cloudflare Pages). |
| `computer_acknowledge_driver` | Computer use (experimental) | deferred | startup | `high-risk` |  | 97 | 25 | Approve a changed computer driver build on this machine (experimental). |
| `computer_apps` | Computer use (experimental) | deferred | startup | `read-only` |  | 90 | 30 | List the desktop apps you may control on this computer, what each allows, and their windows (experimental). |
| `computer_end` | Computer use (experimental) | deferred | startup | `read-only` |  | 78 | 19 | Stop using the computer and release the desktop (experimental). |
| `computer_foreground` | Computer use (experimental) | deferred | startup | `high-risk` | `action*`, `amount`, `captureAfter`, `direction`, `key`, `modifiers`, `observation`, `ref`, `text`, `windowId`, `x`, `y` | 511 | 34 | Bring a granted desktop app to the front and act in it, for apps the background tools cannot drive (experimental). |
| `computer_grant_app` | Computer use (experimental) | deferred | startup | `low-risk` | `bundleId*`, `foreground` | 196 | 24 | Grant this agent a lasting computer-use permission for one app (experimental). |
| `computer_handoff` | Computer use (experimental) | deferred | startup | `low-risk` | `reason*` | 119 | 28 | Pause and ask the person to do a step themselves, such as signing in to an app (experimental). |
| `computer_input` | Computer use (experimental) | deferred | startup | `high-risk` | `action*`, `amount`, `captureAfter`, `direction`, `key`, `modifiers`, `observation`, `ref`, `text`, `windowId`, `x`, `y` | 492 | 25 | Type into a field or press a key or shortcut in a granted desktop app (experimental). |
| `computer_install_driver` | Computer use (experimental) | deferred | startup | `high-risk` |  | 94 | 21 | Install the cua-driver binary on this machine (experimental). |
| `computer_observe` | Computer use (experimental) | deferred | startup | `read-only` | `app`, `query`, `screenshot`, `windowId` | 246 | 30 | Read one window of a granted desktop app as a text outline with refs for its controls (experimental). |
| `computer_pointer` | Computer use (experimental) | deferred | startup | `low-risk` | `action*`, `amount`, `captureAfter`, `direction`, `key`, `modifiers`, `observation`, `ref`, `text`, `windowId`, `x`, `y` | 505 | 27 | Click or scroll in a granted desktop app window without moving your cursor (experimental). |
| `computer_wait` | Computer use (experimental) | deferred | startup | `read-only` | `pollMs`, `timeoutMs`, `until` | 216 | 29 | Wait until the last observed window settles or changes, then return a fresh observation (experimental). |
| `execute_computer_acknowledge_driver` | Computer use (experimental) (hidden) | deferred | startup | `high-risk` |  | 0 | 0 | Runs the action `computer_acknowledge_driver` proposed. |
| `execute_computer_foreground` | Computer use (experimental) (hidden) | deferred | startup | `high-risk` | `action*`, `amount`, `captureAfter`, `direction`, `key`, `modifiers`, `observation`, `ref`, `text`, `windowId`, `x`, `y` | 0 | 0 | Runs the action `computer_foreground` proposed. |
| `execute_computer_grant_app` | Computer use (experimental) (hidden) | deferred | startup | `low-risk` | `bundleId*`, `foreground` | 0 | 0 | Runs the action `computer_grant_app` proposed. |
| `execute_computer_handoff` | Computer use (experimental) (hidden) | deferred | startup | `low-risk` | `reason*` | 0 | 0 | Runs the action `computer_handoff` proposed. |
| `execute_computer_input` | Computer use (experimental) (hidden) | deferred | startup | `high-risk` | `action*`, `amount`, `captureAfter`, `direction`, `key`, `modifiers`, `observation`, `ref`, `text`, `windowId`, `x`, `y` | 0 | 0 | Runs the action `computer_input` proposed. |
| `execute_computer_install_driver` | Computer use (experimental) (hidden) | deferred | startup | `high-risk` |  | 0 | 0 | Runs the action `computer_install_driver` proposed. |
| `execute_computer_pointer` | Computer use (experimental) (hidden) | deferred | startup | `low-risk` | `action*`, `amount`, `captureAfter`, `direction`, `key`, `modifiers`, `observation`, `ref`, `text`, `windowId`, `x`, `y` | 0 | 0 | Runs the action `computer_pointer` proposed. |
| `context_info` | Context | eager | startup | `read-only` |  | 45 | 45 | Report how much of the context window is in use. |
| `get_time` | Context | eager | startup | `read-only` |  | 84 | 84 | Get the current date and time, for a fresh clock in long runs, scheduling or relative times, and... |
| `retrieve_tool_result` | Context | eager | startup | `read-only` | `offset`, `tool_call_id*` | 146 | 146 | Read back a tool result that was offloaded from context or cut to fit it, a page at a time. If... |
| `cd` | File Management | eager | startup | `read-only` | `path*` | 85 | 85 | Change the session working directory for later tool calls. For a single call, pass the path to that... |
| `cp` | File Management | eager | startup | `high-risk` | `destination*`, `force`, `source*` | 128 | 128 | Copy a file or directory, recursively. Pass force to replace an existing destination. |
| `edit_file` | File Management | eager | startup | `high-risk` | `edits*`, `path*`, `snapshot*` | 680 | 680 | Change part of an existing file; to create one, use write_file. Call read_file first and pass its... |
| `execute_cp` | File Management (hidden) | eager | startup | `high-risk` | `destination*`, `force`, `source*` | 0 | 0 | Runs the action `cp` proposed. |
| `execute_edit_file` | File Management (hidden) | eager | startup | `high-risk` | `edits*`, `path*`, `snapshot*` | 0 | 0 | Runs the action `edit_file` proposed. |
| `execute_mkdir` | File Management (hidden) | eager | startup | `low-risk` | `path*`, `recursive` | 0 | 0 | Runs the action `mkdir` proposed. |
| `execute_mv` | File Management (hidden) | eager | startup | `high-risk` | `destination*`, `force`, `source*` | 0 | 0 | Runs the action `mv` proposed. |
| `execute_rm` | File Management (hidden) | eager | startup | `high-risk` | `force`, `path*`, `recursive` | 0 | 0 | Runs the action `rm` proposed. |
| `execute_write_file` | File Management (hidden) | eager | startup | `high-risk` | `content*`, `path*` | 0 | 0 | Runs the action `write_file` proposed. |
| `find` | File Management | eager | startup | `read-only` | `caseSensitive`, `excludePaths`, `includeHidden`, `maxDepth`, `maxResults`, `minDepth`, `mtime`, `name`, `path`, `pathPattern`, `size`, `smart*`, `type` | 407 | 407 | Locate files and directories by name or path; also callable as glob. Pass path for project work.... |
| `grep` | File Management | eager | startup | `read-only` | `contextLines`, `exclude`, `excludeDir`, `filePattern`, `ignoreCase`, `maxResults`, `outputMode`, `path`, `pattern*`, `recursive`, `regex` | 351 | 351 | Search file contents with ripgrep, falling back to grep; use it for every content search, with path... |
| `ls` | File Management | eager | startup | `read-only` | `maxDepth`, `maxResults`, `path`, `pattern`, `recursive`, `showHidden` | 194 | 194 | List one directory. Skips .gitignore'd entries and node_modules; set showHidden to include them. |
| `mkdir` | File Management | eager | startup | `low-risk` | `path*`, `recursive` | 108 | 108 | Create a directory; succeeds if it already exists. To create a file, use write_file, which creates... |
| `mv` | File Management | eager | startup | `high-risk` | `destination*`, `force`, `source*` | 125 | 125 | Move or rename a file or directory. Pass force to replace an existing destination. |
| `pdf_page_count` | File Management | eager | startup | `read-only` | `password`, `path*` | 113 | 113 | Return a PDF's page count and file size. Call it before read_pdf on a large PDF. |
| `pwd` | File Management | eager | startup | `read-only` |  | 49 | 49 | Print the session working directory tools resolve relative paths against. |
| `read_file` | File Management | eager | startup | `read-only` | `endLine`, `maxBytes`, `path*`, `sinceByte`, `sinceInode`, `startLine` | 406 | 406 | Read a file, or a line range with startLine/endLine (negative counts from the end: startLine -20... |
| `read_pdf` | File Management | eager | startup | `read-only` | `maxChars`, `pages`, `password`, `path`, `url` | 221 | 221 | Extract text and tables from a local or remote PDF's text layer. For a large PDF, call... |
| `rm` | File Management | eager | startup | `high-risk` | `force`, `path*`, `recursive` | 115 | 115 | Permanently delete a file or directory (no trash). |
| `stat` | File Management | eager | startup | `read-only` | `path*` | 81 | 81 | Check whether a path exists and get its type, size in bytes and times. A missing path returns... |
| `write_file` | File Management | eager | startup | `high-risk` | `content*`, `path*` | 161 | 161 | Create a UTF-8 file or replace one entirely, creating missing parent directories. To change part of... |
| `end_loop` | Goals and loops | eager | startup | `low-risk` | `reason*` | 117 | 117 | End the loop this run belongs to, so it does not run again: call it when the loop's purpose is met... |
| `propose_goal` | Goals and loops | eager | startup | `low-risk` | `constraints`, `feasibility*`, `name*`, `objective*`, `steps*`, `successCriteria*` | 604 | 604 | Propose a goal the user asked for that needs sustained work across several sessions, e.g. reaching... |
| `report_goal_cycle` | Goals and loops | eager | startup | `low-risk` | `completedStepIds`, `evidence`, `nextAction`, `question`, `status*`, `summary*` | 394 | 394 | Report where the goal stands at the end of this cycle: call it once, as the cycle's last tool call,... |
| `http_request` | HTTP | eager | startup | `high-risk` | `body`, `cacheTtlSeconds`, `followRedirects`, `headers`, `maxResponseBytes`, `method*`, `query`, `timeoutMs`, `url*` | 535 | 535 | Call an HTTP API. Requests run automatically unless the operator configured a URL approval list.... |
| `manage_memory` | Memory | eager | startup | `low-risk` |  | 1190 | 1190 | Remember durable user preferences, facts and corrections across conversations. |
| `propose_lesson` | Memory | eager | startup | `low-risk` | `mistake*`, `rule*`, `scope`, `subject*`, `topic*` | 284 | 284 | Propose a rule learned from your own mistake, for the user to review. |
| `view_memory` | Memory | eager | startup | `read-only` | `path*`, `view_range` | 199 | 199 | Read the user's saved memory. Call with no path to list every scope and its files, then read only... |
| `revise_memory` | Memory curation (internal) | eager | startup | `low-risk` |  | 343 | 343 | Suggest removing a duplicate or stale memory entry, or rewriting a lesson. |
| `ask_peer` | Peers | deferred | per run, when a peer is configured | `high-risk` | `peer*`, `question*` | 182 | 27 | Put one question to somebody else's agent and return their reply. Available peers: peer. The peer... |
| `request_clarification` | Peers | deferred | per run, when a peer is configured | `low-risk` | `question*` | 138 | 31 | While answering a peer's relayed question, ask them one thing back first, such as why they want to... |
| `analyze_media` | Perception Delegation | eager | startup | `high-risk` | `mediaPaths*`, `modality*`, `task*` | 160 | 160 | Have another model analyze image, audio or video you cannot ingest, and get text back. It sees only... |
| `execute_analyze_media` | Perception Delegation (hidden) | eager | startup | `high-risk` | `mediaPaths*`, `modality*`, `task*` | 0 | 0 | Runs the action `analyze_media` proposed. |
| `execute_generate_media` | Perception Delegation (hidden) | eager | startup | `high-risk` | `modality*`, `prompt*` | 0 | 0 | Runs the action `generate_media` proposed. |
| `generate_media` | Perception Delegation | eager | startup | `high-risk` | `modality*`, `prompt*` | 117 | 117 | Have another model generate an image, audio or video file for you. It sees only prompt. |
| `add_reminder` | Reminders | deferred | startup | `low-risk` | `text*`, `when*` | 173 | 27 | Schedule a reminder that will be delivered back to this person later: remind, ping or notify. |
| `cancel_reminder` | Reminders | deferred | startup | `low-risk` | `id*` | 66 | 22 | Cancel a pending reminder by id (get the id from list_reminders first). |
| `list_reminders` | Reminders | deferred | startup | `read-only` |  | 75 | 29 | List this person's reminders, including their id, fire time, text, and delivery status (pending,... |
| `manage_scratchpad` | Scratchpad | eager | startup | `read-only` |  | 484 | 484 | Store bulky working files: research dumps, scraped data, long in-progress drafts. |
| `view_scratchpad` | Scratchpad | eager | startup | `read-only` | `path*`, `view_range` | 202 | 202 | View your durable scratchpad: drafts, research dumps and intermediate artifacts too large or... |
| `who_is_here` | Scratchpad | eager | startup | `read-only` | `directory` | 176 | 176 | Check whether any other jazz agent is currently working in a directory. Call it before checking out... |
| `cancel_wait_for` | Shell Commands | eager | startup | `low-risk` | `batchId*` | 69 | 69 | Cancel a pending wait_for by batch id (get the batch id from wait_for first). |
| `execute_command` | Shell Commands | eager | startup | `unknown` | `command*`, `description*`, `escalate`, `timeout`, `workingDirectory` | 312 | 312 | Run a non-interactive shell command; stdin is empty. Use it for git, package managers, builds,... |
| `execute_execute_command` | Shell Commands (hidden) | eager | startup | `unknown` | `command*`, `description*`, `escalate`, `timeout`, `workingDirectory` | 0 | 0 | Runs the action `execute_command` proposed. |
| `execute_wait_for` | Shell Commands (hidden) | eager | startup | `unknown` | `command*`, `description*`, `intervalMs`, `timeoutMs`, `workingDirectory` | 0 | 0 | Runs the action `wait_for` proposed. |
| `wait_for` | Shell Commands | eager | startup | `unknown` | `command*`, `description*`, `intervalMs`, `timeoutMs`, `workingDirectory` | 383 | 383 | Watch for something to finish, appear, change, drop, arrive or come back up, checking as often as every quarter second, in the background — you keep working and are woken when it happens or after 15 minutes at most. Cancel with cancel_wait_for using the batch id it returns. |
| `find_skills` | Skills | eager | per run, when the agent has skills | `read-only` | `limit`, `query*` | 125 | 125 | Keyword-search the skill catalog and return full descriptions of the top matches. Use it when the... |
| `load_skill` | Skills | eager | per run, when the agent has skills | `read-only` | `skill_name*` | 78 | 78 | Load a skill's full instructions once the index or find_skills matches it to the current task. |
| `load_skill_section` | Skills | eager | per run, when the agent has skills | `read-only` | `section_name*`, `skill_name*` | 115 | 115 | Load a supplementary file a loaded skill's instructions reference. Allowed extensions: .md, .txt,... |
| `list_subagents` | Sub Agents | eager | startup | `read-only` |  | 92 | 92 | Show each sub-agent you started: status (queued, running, paused, waiting-approval, completed,... |
| `map_subagents` | Sub Agents | eager | startup | `read-only` | `inputs*`, `maxCostUSD`, `maxMinutes`, `maxOutputTokens`, `model`, `name`, `persona*`, `reasoning`, `resultName`, `resultSchema`, `task*` | 569 | 569 | Run one brief over a list of inputs: one child per input, each with a fresh context and the same... |
| `post_to_blackboard` | Sub Agents | eager | startup | `read-only` | `content*`, `topic*` | 170 | 170 | Post a finding to the blackboard your parent and sibling sub-agents share, so they can build on it... |
| `read_blackboard` | Sub Agents | eager | startup | `read-only` | `afterId`, `topic` | 141 | 141 | Read what your parent and sibling sub-agents posted to the shared blackboard, oldest first. Read... |
| `spawn_subagent` | Sub Agents | eager | startup | `read-only` | `maxCostUSD`, `maxMinutes`, `maxOutputTokens`, `model`, `name`, `persona*`, `reasoning`, `resultName`, `resultSchema`, `task*` | 609 | 609 | Delegate a self-contained task to a child agent with a fresh context. Returns an agentId at once... |
| `steer_subagent` | Sub Agents | eager | startup | `read-only` | `action*`, `id*`, `message` | 186 | 186 | Steer a running sub-agent by its agentId: message it new guidance, pause it, resume it or cancel... |
| `summarize_context` | Sub Agents | eager | startup | `read-only` |  | 66 | 66 | Summarize older messages to free context. Call it only when you need space before the automatic... |
| `wait_subagents` | Sub Agents | eager | startup | `read-only` | `ids`, `timeoutSeconds`, `until` | 206 | 206 | Wait for sub-agents and get their answers in one call: until all (default) returns once none is... |
| `list_todos` | Todo | eager | startup | `read-only` |  | 39 | 39 | Read the current todo list. |
| `manage_todos` | Todo | eager | startup | `read-only` | `todos*` | 267 | 267 | Replace this conversation's todo list, shown as progress in the UI. Use it for work with three or... |
| `update_work_state` | Todo | eager | startup | `read-only` | `constraints`, `decisions`, `filesTouched`, `goal`, `nextStep`, `openQuestions` | 234 | 234 | Read or update the current task's state; it survives compaction and resumption. Update it when a... |
| `search_tools` | Tool Search | eager | startup | `read-only` | `query*` | 109 | 109 | Fetch full schemas for tools listed only by name and summary; fetched tools stay callable for the... |
| `ask_file_picker` | User Interaction | eager | startup | `read-only` | `base_path`, `extensions`, `include_directories*`, `message*` | 171 | 171 | Let the human pick a file interactively when you cannot identify the file yourself. Interactive... |
| `ask_user_question` | User Interaction | eager | startup | `read-only` | `allow_multiple*`, `question*`, `suggested_responses*` | 291 | 291 | Ask the human one blocking decision: an approach with no clear best option, or sign-off on a... |
| `ask_user_secret` | User Interaction | eager | startup | `read-only` | `name*`, `prompt*` | 250 | 250 | Ask the person to type a password, token or passphrase only they know, such as the password of an... |
| `execute_use_saved_secret` | User Interaction (hidden) | eager | startup | `high-risk` | `name*` | 0 | 0 | Runs the action `use_saved_secret` proposed. |
| `list_saved_secrets` | User Interaction | eager | startup | `read-only` |  | 78 | 78 | List the secrets the person saved for every agent: names and what each is for, never values. Load... |
| `use_saved_secret` | User Interaction | eager | startup | `high-risk` | `name*` | 125 | 125 | Load a secret the person saved earlier (see list_saved_secrets) into this run, so its placeholder... |
| `cancel_trigger` | Wake Triggers | deferred | startup | `low-risk` | `id*` | 68 | 22 | Cancel a pending wake trigger by id (get the id from list_triggers first). |
| `list_triggers` | Wake Triggers | deferred | startup | `read-only` |  | 73 | 27 | List this agent's self-scheduled wake triggers, with each one's delivery status (pending,... |
| `register_trigger` | Wake Triggers | deferred | startup | `low-risk` | `prompt*`, `reason*`, `when*` | 240 | 75 | Wake yourself up later to check back on anything unfinished — monitor, watch or poll it over minutes, hours or days until it is done: a build, deploy, CI run or GitHub Action, a log file, a price or restock, tickets going on sale, a package arriving, a reply, a site coming back up. |
| `web_fetch` | Web Fetch | eager | startup | `read-only` | `max_length`, `offset`, `url*` | 157 | 157 | Fetch a known URL's main content as markdown. JavaScript does not run. Requests run automatically... |
| `web_search` | Web Search | eager | startup | `read-only` | `fromDate`, `maxResults`, `query*`, `searchDepth`, `searchQueries`, `sourceType`, `toDate` | 321 | 321 | Search the public web for titles, URLs and snippets; read full pages with web_fetch. Parameters... |
