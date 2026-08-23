# Headless — the `jazz run` contract

**Reader job:** call Jazz from your own code and get a parseable result back.

`jazz run` is the surface every non-terminal integration is built on. It takes a dynamic
prompt, runs exactly one agent turn, and prints a clean payload. It is the difference
between "a CLI you use" and "a runtime you build on".

```bash
jazz run --agent assistant "summarize the last 5 commits"
```

---

## The stream contract

This is the design decision that makes everything else possible:

> **stdout carries the payload. stderr carries everything else.**

```mermaid
flowchart LR
    RUN["jazz run --json<br/>--agent dev<br/>--events tools"]

    RUN -->|stdout| OUT["<b>Exactly one line</b><br/>the answer, or one JSON object"]
    RUN -->|stderr| ERR["Status notices<br/>tool chatter<br/>the ◉ Agent header<br/>the ✔ completed footer<br/>NDJSON progress events"]
    RUN -->|exit code| CODE["0 = ok<br/>1 = failure"]

    OUT --> PARSE["Your code:<br/>JSON.parse(stdout)"]
    ERR --> LOG["Your code:<br/>log it, or render<br/>a live progress bubble"]

    classDef good fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    classDef noise fill:#e8e8e8,stroke:#999999,color:#1a1a1a
    class OUT,PARSE good
    class ERR,LOG noise
```

No mode flags to remember, no log lines to filter out of your JSON, no Ink TUI writing
escape codes into your pipe (`jazz run` forces `JAZZ_NO_TUI=1` internally). You parse
stdout and you're done.

---

## Output modes

### Plain (default)

stdout is the answer as raw markdown, trimmed, with a trailing newline. Raw markdown is
deliberate — it's the easiest thing to translate downstream into Slack `mrkdwn`, Google
Chat formatting, or Telegram HTML.

```bash
$ jazz run --agent assistant "what is 2+2?"
4
```

On failure stdout is **empty** and the message goes to stderr, so `$(...)` capture never
silently yields an error string.

### JSON (`--json`)

stdout is exactly one single-line object. Always one line, always one object — on success
*and* on failure.

```jsonc
// success
{
  "ok": true,
  "answer": "4",
  "costUSD": 0.000182,
  "costKnown": true,
  "tokenUsage": { "promptTokens": 1204, "completionTokens": 6, "totalTokens": 1210 },
  "toolCalls": [{ "id": "call_1", "name": "read_file", "arguments": "{\"path\":\"…\"}" }]
}
```

```jsonc
// failure
{ "ok": false, "error": "Run exceeded the 300000ms timeout.", "costUSD": 0.0041 }
```

Note that the failure envelope still reports `costUSD` — a run that timed out still
spent money, and an unattended deployment needs to account for it.

Successful envelopes also include `costKnown`. When pricing metadata is unavailable,
`costUSD` remains `0` for compatibility and `costKnown` is `false`; consumers must not
interpret that fallback as a free run.

---

## Flags

| Flag                       | Purpose                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`             | **Required.** Agent id or name.                                                                                                                    |
| `--json`                   | Emit the single-object envelope instead of raw text.                                                                                               |
| `--conversation <id>`      | Stable conversation key. Loads prior history before the run, saves the updated transcript after. Omit for a stateless one-shot.                    |
| `--approval-policy <p>`    | `read-only` \| `low-risk` \| `high-risk`. Tools above the tier are **declined**, not queued.                                                       |
| `--events <categories>`    | Emit NDJSON progress on stderr: `tools,reasoning,text,usage,approval,subagent,all`.                                                                |
| `--reasoning <effort>`     | `low` \| `medium` \| `high` \| `disable`. Overrides the agent's config for this run.                                                               |
| `--timeout <ms>`           | Abort the run after this many milliseconds.                                                                                                        |
| `--max-iterations <n>`     | Cap the agent's reasoning iterations (default 80).                                                                                                 |
| `--stream` / `--no-stream` | Force streaming on/off. Streaming auto-disables for non-TTY stdout, which also suppresses `--events` — pass `--stream` to re-enable it in scripts. |

---

## Prompt input: argument or stdin

The prompt comes from the positional argument, or — when that's absent and stdin isn't a
TTY — from piped stdin.

```bash
jazz run --agent dev "review this diff"          # argument
git diff | jazz run --agent dev                  # stdin
echo "$UNTRUSTED_WEBHOOK_TEXT" | jazz run --agent bot   # stdin, preferred
```

**Use stdin for anything a stranger typed.** Webhook text is untrusted; piping it avoids
shell-escaping it into an argv, which is a whole class of injection bug you don't have to
think about. (It does not make the *content* trusted — see
[Security](../../SECURITY.md).)

---

## Memory without a database

`--conversation <id>` is the feature that makes stateless bridges practical. Pass any
stable key — a Telegram chat id, a Slack thread ts, a support ticket number — and Jazz
handles the transcript for you.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant B as Your bridge<br/>(stateless)
    participant J as jazz run
    participant H as ~/.jazz/history/

    U->>B: "what did I ask you yesterday?"
    B->>J: jazz run --json --conversation 4815162342 "…"
    J->>H: load transcript for key 4815162342
    H-->>J: prior messages
    Note over J: agent runs with full context
    J->>H: save updated transcript
    J-->>B: {"ok":true,"answer":"You asked about…"}
    B->>U: post answer
```

Your bridge stores **nothing**. Storage is LRU-bounded per agent (100 conversations), so
give each external chat its own key and let old ones age out.

Without `--conversation`, each invocation is a clean slate.

---

## Live progress with `--events`

For a chat bridge you usually want to show something before the final answer lands.
`--events` streams newline-delimited JSON on stderr while stdout stays pristine.

```bash
jazz run --json --stream --events tools,subagent --agent dev "audit this repo" \
  2> >(while read -r line; do render_progress "$line"; done)
```

| Category    | Event types emitted                                                              |
| ----------- | -------------------------------------------------------------------------------- |
| `tools`     | `tools_detected`, `tool_call`, `tool_execution_start`, `tool_execution_complete` |
| `reasoning` | `thinking_start`, `thinking_chunk`, `thinking_complete`                          |
| `text`      | `text_start`, `text_chunk`                                                       |
| `usage`     | `stream_start`, `usage_update`, `complete`                                       |
| `approval`  | `approval_required`, `approval_resolved`                                         |
| `subagent`  | `subagent_start`, `subagent_complete`                                            |
| `all`       | every category above                                                             |

`error` events are **always** included regardless of what you select, so a failure can
never be invisible on the live stream.

> `--events` needs streaming. stdout being a pipe auto-disables streaming, so pass
> `--stream` explicitly in scripts and webhooks.

---

## Autonomy

Unattended runs have nobody to ask, so `--approval-policy` decides in advance. Tools
above the tier are **declined** — the agent gets a refusal it can reason about and route
around, rather than hanging forever on a prompt nobody will answer.

| Policy      | Auto-approves                                                  |
| ----------- | -------------------------------------------------------------- |
| *(omitted)* | Nothing. Every gated tool is declined.                         |
| `read-only` | Reading files, search, web requests, `git status`/`log`/`diff` |
| `low-risk`  | + `manage_todos`, `spawn_subagent`                             |
| `high-risk` | + file writes, shell commands, git commit and push             |

Omitting the policy really does grant nothing here. The interactive default auto-approves
read-only and low-risk tools, but that is a statement about prompts it is not worth showing
a person — with nobody to show, an absent policy falls back to declining everything. Shell
commands under `read-only` and `low-risk` are admitted per command by the
[classifier](../internals/tools-and-approval.md#command-classifier), which is what lets
`git log` through without also unlocking `git push`.

> ⚠️ **`low-risk` is narrower than it sounds.** In the built-in toolset it adds only
> `manage_todos`, `update_task_state`, and `spawn_subagent`. Email, calendar, and Obsidian are *skills* that shell
> out via `execute_command` (`unknown`), so a `low-risk` run cannot archive an email. Keep
> the tier low and allowlist the binary instead: `{"autoApprovedCommands": ["himalaya"]}` in
> `~/.jazz/config.json`. See [Tools reference](../reference/tools.md#what-is-not-a-built-in-tool).

Pick the lowest tier that lets the job finish. `high-risk` on a surface that accepts
input from strangers means a prompt injection can run shell commands on that host — see
[Security](../../SECURITY.md).

---

## A complete bridge

Everything above, in one function. This is genuinely the whole integration:

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
      "--agent", "assistant",
      "--conversation", chatId,
      "--approval-policy", "low-risk",
      "--timeout", "300000",
    ]);

    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => console.error(chunk.toString()));

    child.stdin.write(message);
    child.stdin.end();

    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout) as JazzResult);
      } catch {
        resolve({ ok: false, error: "jazz produced no JSON envelope", costUSD: 0 });
      }
    });
  });
}
```

Swap `spawn` for your platform's SDK around it and you have a bot. That's exactly what
the [Telegram](./chat-platforms.md) and [Discord](./chat-platforms.md) bridges do.

---

## Related

- [Chat platforms](./chat-platforms.md) — this contract, wired to a real transport
- [CI/CD](./ci-cd.md) — the same contract inside GitHub Actions
- [Tools & approval](../internals/tools-and-approval.md) — how risk tiers are decided
- [CLI Reference](../reference/cli.md) — every command and flag
