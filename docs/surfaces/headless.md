---
description: "Call Jazz from your own code with jazz run: pass a dynamic prompt, get structured JSON back, control autonomy and timeouts: the contract every integration builds on."
---

# Headless

How to call Jazz from your own code and get a parseable result back.

Create an agent first with `jazz agent create` and name it `assistant`, or replace
`assistant` below with an existing agent name. `jazz run` takes a prompt, runs one
agent turn, and prints the answer.

```bash
jazz run --agent assistant "summarize the last 5 commits"
```

---

## The stream contract

stdout contains the answer: Markdown by default, or a single JSON object with `--json`.
Status messages, warnings, tool output, and NDJSON progress events go to stderr.

---

## Output modes

### Plain (default)

stdout is the answer as raw Markdown, trimmed, with a trailing newline.

```bash
$ jazz run --agent assistant "what is 2+2?"
4
```

On failure stdout is **empty** and the message goes to stderr, so `$(...)` capture never
silently yields an error string.

### JSON (`--json`)

stdout contains one single-line JSON object on success or failure.

An invalid configuration file or a missing `--config` path also returns this failure
envelope with `code: "failed"` and `costUSD: 0`, even before the agent starts. Recovery
instructions stay on stderr. `jazz workflow run --json` follows the same rule.

```jsonc
// success
{
  "ok": true,
  "answer": "4",
  "costUSD": 0.000182,
  "costKnown": true,
  "tokenUsage": { "promptTokens": 1204, "completionTokens": 6, "totalTokens": 1210 },
  "toolCalls": [{ "id": "call_1", "name": "read_file", "arguments": "{\"path\":\"…\"}" }],
}
```

```jsonc
// failure
{
  "ok": false,
  "code": "failed",
  "error": "Run exceeded the 300000ms timeout.",
  "costUSD": 0.0041,
  "costKnown": true,
  "tokenUsage": { "totalTokens": 5210 },
}
```

Failure results include spend and token usage once the run reaches the model. A failure
before the first model call reports `costUSD: 0`.

A force-killed process cannot return a result. To track its spend, request the `spend`
event category and save the latest `run_spend` event, which reports totals after each
model call and tool batch.

`code` says why a run failed, so a script can branch without parsing `error`:

| `code`             | Meaning                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `failed`           | The run errored: provider, tool, configuration, or timeout                                                          |
| `empty_response`   | The model returned an empty completion with zero tokens: usually a misconfigured or overloaded provider             |
| `no_answer`        | The model stopped for a reason other than `stop` (for example `length`) before writing anything; see `finishReason` |
| `content_filtered` | The provider's content filter withheld the answer                                                                   |
| `interrupted`      | SIGINT or SIGTERM stopped the run; `signal` names which                                                             |

A run that finishes without a usable answer is a failure, never `ok:true` with an empty
`answer`.

### What else the envelope tells you

These fields appear on the success envelope only when they apply:

| Field                                         | Meaning                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finishReason`                                | Why the model stopped writing the answer: `stop`, `length`, `tool-calls`, `other`, or `unknown`                                                                                  |
| `truncated`                                   | `true` when the answer was cut off at the model's output limit (`finishReason: "length"`). The answer is still returned, and stderr carries a warning                            |
| `iterationLimited`                            | `true` when the run used every allowed iteration (`--max-iterations`) without a final answer                                                                                     |
| `toolsDisabled`                               | `true` when the agent has tools but none were sent, because Jazz does not know the model supports tool calling. The agent could only talk. stderr carries a warning with the fix |
| `costCapped`, `tokenCapped`, `durationCapped` | `true` when a run budget stopped the run early                                                                                                                                   |

Jazz assumes a cloud model supports tools when neither its catalog nor your config says
otherwise, so a newly released model keeps its tools. A local server's model gets tools once
the server reports them. When Jazz cannot tell, override it with
`jazz config set 'llm.capabilityOverrides.<provider>."<model>".supportsTools' true`.

### Exit codes

| Code  | Meaning                                                                         |
| ----- | ------------------------------------------------------------------------------- |
| `0`   | An answer was produced                                                          |
| `1`   | The run failed, or finished without a usable answer (see `code`)                |
| `2`   | The run is parked on an approval (`--park`); resume it with `jazz runs approve` |
| `130` | SIGINT (Ctrl+C) stopped the run                                                 |
| `143` | SIGTERM stopped the run                                                         |

On SIGINT or SIGTERM, `--json` stdout still carries exactly one envelope:
`{"ok":false,"error":"interrupted","code":"interrupted","signal":"SIGTERM",...}`. The shutdown
notice goes to stderr. A second signal exits at once with the same code and envelope.

Successful envelopes also include `costKnown`. When pricing metadata is unavailable,
`costUSD` remains `0` for compatibility and `costKnown` is `false`; consumers must not
interpret that fallback as a free run.

---

## Flags

| Flag                       | Purpose                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--agent <id>`             | **Required.** Agent id or name.                                                                                                                                                                                                |
| `--json`                   | Emit the single-object envelope instead of raw text.                                                                                                                                                                           |
| `--conversation <id>`      | Stable conversation key. Loads prior history before the run, saves the updated transcript after. Omit for a stateless one-shot.                                                                                                |
| `--approval-policy <p>`    | `read-only` \| `low-risk` \| `high-risk`. Tools above the tier are **declined**, not queued.                                                                                                                                   |
| `--watch <categories>`     | Watch the run: NDJSON progress on stderr: `tools,reasoning,text,usage,approval,subagent,spend,all`. Alias of `--events`; pass one or the other.                                                                                |
| `--reasoning <effort>`     | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `disable`. Overrides the agent's config for this run; a level the model does not accept runs at the nearest one it does, with a warning on stderr.             |
| `--with-vision <p/m>`      | Bind the `analyze:image` companion for this run, e.g. `openrouter/inclusionai/ling-3.0-flash-vl`. Overrides the agent's config. Without a bound companion (flag or config), `analyze_media` fails loudly rather than guessing. |
| `--with-audio <p/m>`       | Same, for the `analyze:audio` companion.                                                                                                                                                                                       |
| `--with-video <p/m>`       | Same, for the `analyze:video` companion.                                                                                                                                                                                       |
| `--timeout <ms>`           | Abort the run after this many milliseconds.                                                                                                                                                                                    |
| `--max-iterations <n>`     | Cap the agent's reasoning iterations (default 100).                                                                                                                                                                            |
| `--input-stdin`            | Read the prompt (and, with `--ephemeral`, prior `history`) from the first stdin line as JSON. See [below](#prompt-input-argument-stdin-or-an-input-frame).                                                                     |
| `--stream` / `--no-stream` | Force streaming on/off. Streaming auto-disables for non-TTY stdout; `--watch reasoning`/`text` re-enable it on their own, since those events exist only on the streaming path.                                                 |

---

## Prompt input: argument, stdin, or an input frame

The prompt comes from the positional argument, from an `--input-stdin` frame, or: when
neither is given and stdin isn't a TTY: from piped stdin.

```bash
jazz run --agent dev "review this diff"          # argument
git diff | jazz run --agent dev                  # stdin
echo "$UNTRUSTED_WEBHOOK_TEXT" | jazz run --agent bot   # stdin, preferred
echo '{"prompt":"- buy milk"}' | jazz run --agent bot --input-stdin   # frame
```

**Use stdin for anything a stranger typed.** Webhook text is untrusted; piping it avoids
shell-escaping it into an argv, which is a whole class of injection bug you don't have to
think about. (It does not make the _content_ trusted: see
[Security](../../SECURITY.md).)

**Keep relayed messages off the command line.** Every account on a host can read another
process's arguments through `ps` and `/proc/<pid>/cmdline`, and Linux caps a single argument at
128 KiB. A bridge that relays a person's message, and for an incognito chat that person's whole
transcript, sends them in the `--input-stdin` frame: one JSON line, then the rest of stdin is
free for `--interactive-stdin` answers.

```json
{ "prompt": "what did I say about the dentist?", "history": [] }
```

`history` is read only with `--ephemeral`: pass back the `messages` array of the previous
`--ephemeral --json` envelope to keep multi-turn context without anything on disk. A framed
prompt is the caller's own message, so like a positional prompt it may back a memory write; a
body piped without the frame never can.

---

## Memory without a database

`--conversation <id>` is the feature that makes stateless bridges practical. Pass any
stable key (a Telegram chat id, a Slack thread ts, a support ticket number) and Jazz
handles the transcript for you.

Your bridge stores **nothing**. Each agent keeps its 100 most recently used conversations
(`history.maxConversationsPerAgent`), so give each external chat its own key and let old ones
age out: they are archived under `~/.jazz/history/archive/`, not deleted. See
[sizes and retention](../runtime-data/index.md#sizes-and-retention).

Without `--conversation`, each invocation is a clean slate.

---

## Live progress with `--watch`

For a chat bridge you usually want to show something before the final answer lands.
`--watch` (alias of `--events`, both take the same categories) streams
newline-delimited JSON on stderr while stdout stays pristine.

```bash
jazz run --json --stream --watch tools,subagent --agent dev "audit this repo" \
  2> >(while read -r line; do render_progress "$line"; done)
```

| Category    | Event types emitted                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `tools`     | `tools_detected`, `tool_call`, `tool_execution_start`, `tool_execution_complete`                |
| `reasoning` | `thinking_start`, `thinking_chunk`, `thinking_complete`                                         |
| `text`      | `text_start`, `text_chunk`                                                                      |
| `usage`     | `stream_start`, `usage_update`, `complete`                                                      |
| `approval`  | `command_risk_classifying`, `command_risk_classified`, `approval_required`, `approval_resolved` |
| `subagent`  | `subagent_start`, `subagent_complete`, `subagent_result`                                        |
| `spend`     | `run_spend`: the run's total spend so far, after each model call and tool batch                 |
| `all`       | every category above                                                                            |

`error` events are **always** included regardless of what you select, so a failure can
never be invisible on the live stream.

Streaming auto-disables when stdout is a pipe, which is every headless caller. Tool,
approval and subagent events survive that: the batch path routes them through the same
renderer, but `reasoning` and `text` deltas exist only on the streaming path. Asking for
either category therefore turns streaming back on for you; pass `--no-stream` if you would
rather keep the batch path and take tool events only.

---

## Asking the human something

Unattended runs omit `ask_user_question`, `ask_file_picker`, and `ask_user_secret`
from the tool list.

When stdin is a terminal, these tools are available without an extra flag.
Answer a question by typing an option number or your own response.

```text
❓ Which database?
  1) Postgres: the default
  2) SQLite
Answer (number, or type your own; empty to skip):
```

A chat bridge is the case that cannot be detected: through a pipe it looks exactly like a
cron job. It declares itself with `--interactive-stdin`, and the question then becomes a
line on the event stream instead of a prompt:

```json
{
  "type": "user_input_required",
  "requestId": "ui-1",
  "question": "When is your appointment?",
  "suggestions": [
    { "value": "today", "label": "Today" },
    { "value": "tomorrow", "label": "Tomorrow" }
  ],
  "allowCustom": true
}
```

The run blocks until you write the answer back on **stdin**, exactly as approvals work:

```json
{ "type": "user_input_response", "requestId": "ui-1", "response": "tomorrow" }
```

`response` should be one of the suggestions' `value` fields, though any string is accepted
when `allowCustom` is true. An empty response is treated as no answer: the tool reports
that it could not ask and the model is told to state an assumption or put the question in
its reply instead. Time spent waiting does not count against `--timeout`, so a human can
take as long as they like.

Questions are never truncated. Telegram and Discord render suggestions as buttons.

`CI=true` disables terminal input detection. An explicit `--interactive-stdin`
still enables input events.

---

## Autonomy

Unattended runs have nobody to ask, so `--approval-policy` decides in advance. Tools
above the tier are **declined**: the agent gets a refusal it can reason about and route
around, rather than hanging forever on a prompt nobody will answer.

| Policy      | Auto-approves                                                      |
| ----------- | ------------------------------------------------------------------ |
| _(omitted)_ | Nothing. Every gated tool is declined.                             |
| `read-only` | Reading files, search, web requests, `git status`/`log`/`diff`     |
| `low-risk`  | + memory writes, reminders, triggers, low-risk classified commands |
| `high-risk` | + file writes, shell commands, git commit and push                 |

Omitting the policy grants nothing, here and in the interactive terminal alike: with nobody to
ask, every gated call is declined. To run everything unasked, pass `--approval-policy high-risk`
explicitly (see [Running fully unattended](../security/approvals.md#running-fully-unattended-yolo)). Shell
commands under `read-only` and `low-risk` are admitted per command by the
[classifier](../security/approvals.md#shell-commands-are-classified-individually), which is what lets
`git log` through without also unlocking `git push`.

Skills such as email, calendar, and Obsidian run commands through `execute_command`.
Their mutations may require a higher tier. Prefer human approval or a narrowly scoped
command grant; see [email and calendar setup](../configure/email-calendar.md).

Pick the lowest tier that lets the job finish. `high-risk` on a surface that accepts
input from strangers means a prompt injection can run shell commands on that host: see
[Security](../../SECURITY.md).

---

## One-shot run in a sandbox

Use a fresh container per job, mount the input read-only, and give Jazz a writable,
ephemeral data directory:

```bash
docker run --rm --read-only --tmpfs /tmp \
  -e JAZZ_HOME=/tmp/jazz-home -e OPENAI_API_KEY \
  -v /etc/myapp/jazz-config:/config/jazz:ro \
  -v "$PWD:/workspace:ro" -w /workspace \
  my-image sh -c '
    umask 077
    mkdir -p "$JAZZ_HOME"
    cp -r /config/jazz/. "$JAZZ_HOME/"
    exec jazz run --agent reviewer --approval-policy read-only \
      --max-cost-usd 2 --timeout 300000 "Review the files in this checkout."
  '
```

`my-image` must have Jazz installed. The seed directory must be readable by the
container user and contain `agents/reviewer.json`; this example assumes an OpenAI agent
and `OPENAI_API_KEY` supplied through the host environment. Use the matching credential
for another provider.

`JAZZ_HOME` holds runtime state and caches as well as configuration, so it must be writable.
The seed configuration and checkout stay read-only; the copied configuration can change
inside the container. Its changes and runtime state disappear when the container exits.
Keep writable host mounts and unrelated credentials out of the job. See
[Unattended runs](../security/unattended-runs.md) for tool and credential restrictions.

---

## Calling Jazz from Node.js

This function passes a message to Jazz and reads its JSON result:

```ts
import { spawn } from "node:child_process";

interface JazzResult {
  ok: boolean;
  answer?: string;
  error?: string;
  costUSD: number;
  costKnown?: boolean;
}

export function askJazz(chatId: string, message: string): Promise<JazzResult> {
  return new Promise((resolve) => {
    const child = spawn("jazz", [
      "run",
      "--json",
      "--agent",
      "assistant",
      "--conversation",
      chatId,
      "--approval-policy",
      "low-risk",
      "--timeout",
      "300000",
    ]);

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => console.error(chunk.toString()));

    child.stdin.on("error", (error) => {
      resolve({ ok: false, error: error.message, costUSD: 0, costKnown: false });
    });
    child.stdin.write(message);
    child.stdin.end();

    child.on("error", (error) => {
      resolve({ ok: false, error: error.message, costUSD: 0, costKnown: false });
    });

    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout) as JazzResult);
      } catch {
        resolve({
          ok: false,
          error: "jazz produced no JSON envelope",
          costUSD: 0,
          costKnown: false,
        });
      }
    });
  });
}
```

For platform authentication, message delivery, and interactive approvals, see
[Chat platforms](./chat.md).

---

## Related

- [Chat platforms](./chat.md): this contract, wired to a real transport
- [CI/CD](./ci.md): the same contract inside GitHub Actions
- [Approvals](../security/approvals.md): what runs without asking
- [Commands and flags](../commands.md): every command and flag
