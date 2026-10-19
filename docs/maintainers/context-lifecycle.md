---
description: "Why a long Jazz run doesn't fall off its context window: compaction strategies, priority tiers, and what gets dropped first."
---

# Context management

This page explains why a long Jazz run doesn't fall off the end of its context
window.

Source:
[`context/summarizer.ts`](../../packages/core/src/agent/context/summarizer.ts) ·
[`context/context-window-manager.ts`](../../packages/core/src/agent/context/context-window-manager.ts) ·
[`context/token-counter.ts`](../../packages/core/src/agent/context/token-counter.ts)

Context is the scarce resource in an agent run. Tool results are large, they accumulate
every iteration, and running out means either a provider error or silently forgetting the
task. Jazz manages it with three mechanisms that do different jobs and are easy to
confuse.

---

## Three mechanisms, three jobs

```mermaid
flowchart TB
    subgraph counting["1 · Counting: how full are we?"]
        TC["Token counter<br/>estimate before the call,<br/>calibrate after it"]
    end

    subgraph trimming["2 · Trimming: cheap, every iteration"]
        TR["Drop the oldest messages<br/>that fit no budget.<br/>No LLM call. Lossy."]
    end

    subgraph compaction["3 · Compaction: expensive, at 80%"]
        CO["Summarize the middle,<br/>keep system + recent.<br/>One LLM call. Lossy but coherent."]
    end

    TC --> TR
    TC --> CO

    classDef cheap fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    classDef pricey fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    class TC,TR cheap
    class CO pricey
```

|             | Trimming                                                                                   | Compaction                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Runs        | before each request and after each reply, once tokens exceed **95%** of the context budget | when tokens exceed 80% of the context budget (the model's window, or the agent's `llm.maxContextTokens` ceiling when it is lower) |
| Costs       | nothing                                                                                    | one LLM call                                                                                                                      |
| Budget      | 95% of the context budget                                                                  | the context window the provider will actually honour                                                                              |
| What's lost | old messages, entirely                                                                     | detail: the gist survives as a summary                                                                                            |
| Preserves   | system message, compaction summary, pinned messages + last N complete turns                | system message + a summary + recent messages                                                                                      |

**Trimming sits above compaction, deliberately.** Its budget is 95% of the context budget,
compaction's is 80%, so compaction always gets first refusal and trimming only fires when
summarizing could not bring the run under budget: a single tool result too large to
summarize around, for example. When it does fire you are told, because messages are being
discarded without being summarized.

This ordering used to be inverted. The trim budget was a flat 50,000 tokens regardless of
the model, so on any window larger than ~62k (50k ÷ 0.8) trimming pre-empted compaction
entirely: history was held at 50k by discarding the oldest turns, the 80% threshold was
never reached, and the summarizer never ran. The run degraded into exactly the sliding
window this design exists to avoid, and, because trimming rewrites the start of the
message list, it also invalidated the provider's cacheable prefix on every single turn.

Trimming keeps the working set tidy. Compaction is what saves a run that genuinely has more
history than fits.

When compaction cannot do its job, the loop goes straight to trimming instead of carrying on
over budget. That happens when the summarizer fails, when it returns an empty summary or one cut
off at its output limit (both are refused, and the original messages stay), or when everything
over the limit is recent and nothing is old enough to summarize. The history is then trimmed to
the compaction threshold, and the user is told once. A summarizer failure never fails the run.

When the provider itself rejects a request as too long (`contextOverflow` on the error: the
window was smaller than estimated), the loop compacts regardless of the estimate, or trims to 70%
of the history's size when compaction cannot run, and retries once. A second rejection fails the
run.

---

## 1 · Counting tokens

You can't decide whether to compact without knowing how full you are, and every provider
tokenizes differently. Jazz uses two tiers.

```mermaid
sequenceDiagram
    autonumber
    participant L as Agent loop
    participant C as Token counter
    participant M as Model

    Note over C: Tier 2: estimate
    L->>C: countMessages(messages, {provider, modelId})
    alt OpenAI family
        C-->>L: exact count (gpt-tokenizer, cl100k / o200k)
    else everything else
        C-->>L: chars ÷ calibrated ratio<br/>(seed: Claude 3.5, Gemini 4.0, Llama 3.6 …)
    end

    L->>M: completion request
    M-->>L: response + usage.promptTokens

    Note over C: Tier 1: ground truth
    L->>C: calibrate(authoritative = usage.promptTokens)
    Note over C: learn this model's real chars/token<br/>smoothing 0.7, clamped to [2, 6]
```

**Tier 1: authoritative calibration.** After every call the provider reports
`usage.promptTokens`: its own count of exactly what we sent. Jazz feeds that back and the
counter learns a per-model chars-per-token ratio. Ground truth, free, one round trip.

**Tier 2: pre-call estimate.** Before the _next_ call, we need a number to compare against
the threshold. OpenAI-family encodings use `gpt-tokenizer` for an exact count. Everything
else uses the calibrated ratio if we have one, or a family seed if we don't.

Why no Anthropic tokenizer: `@anthropic-ai/tokenizer` is stale (Claude-2 era) and the
official `count_tokens` endpoint is a network call on the hot path. Calibration converges
after one exchange and costs nothing.

Per-message overheads are counted too. 4 tokens for role tags and separators, plus 10 more
for tool-result messages, which are numerous enough that ignoring their framing drifts the
estimate.

---

### Memory observations at the request boundary

The runner snapshots every file in the agent's allowed memory scopes once per run, reading each
file once, and takes a fresh snapshot after the run's own `manage_memory` writes. Writes by other
processes show up on the next run. The snapshot skips linked scopes and files so external paths
cannot enter receipts or provenance, and a scope it cannot read is skipped and logged rather than
failing the others. The store assigns an ID on first snapshot and hashes the current file content.

Pending receipts are written in a fiber forked beside the provider call, so they add no latency to
the request; the loop joins it once the provider responds and completes the receipts. Exposure
comes from the rendered standing line, or from the `memoryExposure` a successful `view_memory`
call declares, keyed by canonical path and counted only while that exact tool message remains in
the request. Directory listings, cleared or edited results, and merely selected candidates have no
exposure. A failed provider call leaves receipts pending, so a crash cannot look like a success.
Each message's content is hashed once and reused while it is unchanged, so identifying a request
costs work proportional to what changed (`bun bench/memory-opportunity-receipts.bench.ts`).

The store keeps at most 128 receipts per entry, pruning once every 32 writes. Forgetting a file
starts a new epoch for its scope under the scope's lock and removes the whole scope's receipts;
tickets from an older epoch cannot write after deletion, which also covers missing or stale
provenance IDs. An unreadable epoch file is moved aside and replaced. `memory explain` shows five
recent records without raw memory text. Calibration must use independent labels before any
receipt can drive lesson changes or skill proposals.

## 2 · Trimming: turn-aware, never mid-tool-call

Trimming is checked before every request and after every reply, against 95% of the context
budget. The subtlety isn't _what_ to drop, it's what must never be split.

```mermaid
flowchart TB
    subgraph before["Before trim"]
        direction TB
        B0["0 · system"]
        B1["1 · user: 'audit the repo'"]
        B2["2 · assistant + tool_calls"]
        B3["3 · tool result (large)"]
        B4["4 · user: 'also check tests'"]
        B5["5 · assistant + tool_calls"]
        B6["6 · tool result"]
        B7["7 · user: 'summarize'"]
        B8["8 · assistant"]
    end

    subgraph after["After trim"]
        direction TB
        A0["0 · system. <b>always kept</b>"]
        A4["4–8 · last N complete turns<br/><b>protected zone</b>"]
        A2["2–3 kept only if they fit<br/>,  and only <b>together</b>"]
    end

    before --> after

    classDef keep fill:#4f9d9d,stroke:#2f6d6d,color:#ffffff
    classDef maybe fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    class A0,A4 keep
    class A2 maybe
```

The algorithm:

1. **System message is index 0 and always survives.** It carries the agent's identity and rules. So do the compaction summary, the continuation nudge after it, and pinned messages (a workflow's task): they sit right after the system message, and the summary is the only record of everything compaction replaced.
2. **Identify the protected zone**: the last N complete _turns_, scanning backwards for user messages (default 3). A "turn" is a user message plus every assistant and tool message after it until the next user message. Complete interaction cycles, not a raw message count.
3. **Walk backwards** from just before the protected zone, keeping messages while they fit the budget.
4. **Validate tool integrity.** An assistant message with `tool_calls` and its corresponding `tool` result messages are kept or dropped as a unit.

Step 4 is the one that matters. A history containing `tool_calls` with no matching `tool`
message is _invalid_ to most providers: you get a 400 several iterations later, far from
the cause. Turn-awareness makes that structurally impossible rather than something to
remember.

---

## 3 · Compaction: summarize, don't truncate

At 80% of the model's real context window, Jazz stops discarding and starts summarizing.

```mermaid
flowchart LR
    subgraph in["Before. 92% full"]
        direction TB
        S["system"]
        MID["… 60 messages of<br/>research, tool results,<br/>dead ends …"]
        REC["recent messages"]
    end

    SUM["<b>Summarizer sub-agent</b><br/>own model (configurable)<br/>own context"]

    subgraph out["After. 30% full"]
        direction TB
        S2["system"]
        SUMMSG["<b>summary</b><br/>one assistant message:<br/>what was found, what's left"]
        REC2["recent messages<br/>(sanitized)"]
    end

    MID --> SUM
    SUM --> SUMMSG
    S --> S2
    REC --> REC2

    classDef hot fill:#f9a03f,stroke:#b3541e,color:#1a1a1a
    class SUM,SUMMSG hot
```

The rebuild is `[system, ...pinned, summary, continuation, ...recent]`. The middle, where
the bulk of the tokens live, becomes one message describing what was learned. A summary
left by an earlier compaction is merged into the new one, never summarized again as raw
history and never dropped, and a workflow's task message (`kind: "task"`) is kept verbatim
through every cycle.

**The recent tail is bounded, not a bare ratio.** The newest messages kept verbatim fill
20% of the context window, clamped to 8K–40K tokens (`recentTailTokenBudget`). The tail
holds the current request and its live tool results, which are roughly the same size on
any window: an uncapped 20% of a 1M window would keep 200K tokens and free little per
compaction, while 20% of a 32K window is less than one large tool result. On windows under
32K the floor shrinks to a quarter of the window, so the rebuild still lands well under
the warn rung. The newest message is always kept, even when it alone exceeds the budget.

The summary is a fixed checkpoint rather than free-form prose. Every compaction writes:

```md
## Goal

## Constraints & Preferences

## Covered So Far

## Progress

### Done

### In Progress

### Blocked

## Key Decisions

## Next Steps

## Critical Context
```

On later compactions Jazz merges new evidence into that same schema: completed items move
to **Done**, resolved blockers disappear, and **Next Steps** is refreshed. The source
transcript and prior checkpoint are passed as untrusted reference material, not
instructions for the summarizer to execute.

**Covered So Far** is the anti-repetition section. Its failure mode: a review or audit
pass compacts mid-work, the model's "which files have I read" record dies with the
summarized messages, and it restarts the pass — re-reading every file it just read and
looping out of its iteration budget on its own repetition. The checkpoint must therefore
carry the list of covered sources (exact paths), and the merge rule is cumulative:
anything an earlier checkpoint says was covered stays covered, so the second compaction
of a long pass does not drop the first half's list.

The checkpoint covers the _summarized_ half of the history. The _kept_ half is handled
mechanically instead: after a compaction the next request appends a progress note
built from the kept messages' own tool calls (`extractRunProgress`) — files read,
files modified, commands run, most recent action — prefixed with "do not redo it".
Together the two records mean the resumed model never has to guess what it already
did.

**Why summarize rather than slide a window?** A sliding window drops the _plan_. Forty
minutes into a research run, the early messages contain the task definition and the
strategy; the recent ones contain a tool result about page 14 of a PDF. Truncating keeps
the trivia and throws away the point. Summarizing keeps the point.

**The cost, honestly stated:** compaction is an extra LLM call (two, when the memory pass
below also runs), it adds latency mid-run, and a summary is lossy: a detail the agent needed
might not survive. Mitigations:

- **`llm.summarizerModel` is configurable per agent.** Point compaction at a cheap fast model while the main agent runs an expensive one. Falls back to the agent's own model, with a warning if the configured value is unparseable.
- **It's visible.** You get a `Context window ~83% full (~100,046 of 120,000 tokens): auto-compacting…` warning, then `Compacted 64 → 12 messages (saved ~48000 tokens)`. Never silent.
- **You can force it.** `/compact` in chat, or the `summarize_context` tool, which the agent can call itself when it knows it's about to go deep. Both go through `Summarizer.compact`, the same path automatic compaction takes: recent messages kept, the earlier summary merged, a journal entry written. They differ from it only in when they run.
- **It's skipped when pointless.** If there's nothing in the middle worth summarizing, the messages come back untouched, with no "auto-compacting" notice, and the loop trims instead.
- **A bad summary never replaces history.** An empty summary, or one the summarizer model cut off at its output limit, is refused and the original messages stay.

### Durable facts are suggested for memory before the summary

The summary keeps a run resumable _within_ its conversation. It does nothing for the _next_
conversation: a preference the user stated forty messages ago survives compaction only as
summary gist, and vanishes entirely when the conversation ends. So at the compact rung, just
before the middle is condensed, Jazz scans exactly those about-to-be-compressed messages for
anything worth remembering long term and queues it for the person to review
([`memory-extractor.ts`](../../packages/core/src/agent/context/memory-extractor.ts)).

It runs as a throwaway `memory-extractor` sub-agent on the summarizer model, and it uses the
real `view_memory`/`manage_memory`/`propose_lesson` tools rather than a bespoke write path — so it inherits
their discipline: find the right scope, read the file before changing it, one file per subject,
replace stale facts instead of appending duplicates. The scopes are the parent agent's.

**It reads the whole conversation, but saves only from the scanned slice.** Whether a statement
is a lasting preference or an instruction for the task at hand, and whether the user later took
it back, shows only in the rest of the conversation. So the extractor also gets a context block
ahead of the transcript: the prior summary, and the recent tail that stays verbatim (for the
`conversation-end` pass, the already-reflected earlier messages instead). Nothing in that block
carries a memory-source tag, so no quote from it passes `manage_memory`. The block takes at most
40% of the extractor's input budget; past that it keeps the summary, then the newest later
messages, then the newest earlier ones.

**Its writes are queued, not written.** When `manage_memory` runs as `memory-extractor`, a
`create` or `amend` passes every check a direct write would (quote, sensitivity, revoked
sentences, subject and topic rules), and is then stored as a fact suggestion in the review queue
(`.pending-memory.json` at the memory root) next to lessons from `propose_lesson`. `delete` and
`rename` are refused for the extractor. Because queueing changes nothing in memory, both
extractor passes list `manage_memory` and `propose_lesson` in the sub-run's `autoApprovedTools`:
compaction no longer raises one approval prompt per write. The chat prints how many suggestions
are waiting at the end of the turn, and at the next chat opening.

Nothing reaches memory from the queue except `MemoryService.acceptSuggestion`, reached from
`/memory review`, `/memory accept`, `jazz memory review` and `jazz memory accept`. The review
commands show every waiting item and one multi-select: checked items are accepted, the rest
rejected, Escape decides nothing. Accept looks up, writes and dequeues under one hold of the
memory write lock so a concurrent reject cannot be overridden. A fact is written with origin
`auto` and its quoted sentence keys, so a correction or forget made since it was suggested still
revokes it; an amendment replaces the exact content it was suggested against, and fails (staying
queued) if the entry changed in between.

The extractor receives authenticated source IDs for the original user messages in the chunk.
The write tool checks an exact quoted span against those messages. A compaction chunk with no
authenticated user source is skipped, and text inside tool output or a rendered transcript
cannot create its own user source.
Corrected and forgotten claims revoke the sentences they quoted in the hidden cross-scope source
ledger. An extractor attempting to re-save a superseded quote from those sentences receives a
failed write; other sentences of the same message, and any new user message, can still be quoted.

The same pass runs a second way, as `conversation-end`. When a chat conversation is closed or
left, the chat spawns a detached `jazz memory reflect` (hidden), so neither the person nor the
chat process waits on it. The application layer passes the chat's `--config` path through to
the detached command; without an explicit path the child inherits normal environment-based
config resolution. That process loads the saved conversation and takes the messages
after a per-conversation watermark (`.reflected-conversations.json` at the memory root). It
claims them before the model call, so two reflections never cover the same messages. It then
runs the extractor with the same tools as at compaction; its suggestions need no prompt in the
chat that already closed. The pass reads at most the two newest chunks of what it claimed and
logs any it skipped. The chat skips the spawn for ephemeral sessions and for conversations with
no turn in this session. A hard kill (SIGTERM mid-chat) skips it too; the next close of that
conversation covers the missed messages.

A third way is `learn`, run in the foreground by `/learn` (alias `/reflect`). It claims the same
watermark from the saved conversation, with scoped cleanup registered as part of claiming it. A
failure or interruption before learning completes, including a pending-suggestions read failure,
releases the claim so those messages can be retried. It scans with the same chunk bound under the
`memory-learner` id, then makes one curation call. That call receives the session's memory diff
(a snapshot of every entry's first line and content hash, taken when the chat started, against
the store now) and the suggestions already waiting. It holds `revise_memory`, which no agent is
offered: the tool sits in the internal `memory_curation` category, which every registry listing
skips. It queues `revision` suggestions: a delete or a lesson rewrite, each recorded against the
entry's current text so a kept one fails if the entry changed. Fact entries are never rewritten,
since they hold the user's quoted words. The chat then opens the review checklist over the whole
queue.

**The bar is deliberately narrow.** Only facts the user themselves stated or decided —
stable preferences, recurring facts, standing project decisions — qualify. The model's own
inferences, in-progress task state, tentative thoughts, secrets, and small talk do not.
Writing nothing is the common, correct outcome; the pass does not invent memories to look
useful.

**It is gated, and the gate is enforced here, not inherited.** Only the top-level,
persistence-enabled run extracts. A `--ephemeral` or A2A-peer run means "write nothing"
(`disablePersistence`), and sub-agent runs have no human user for the user-stated bar — both
skip the pass. This matters because the recursive runner does _not_ carry `disablePersistence`
into a sub-run, so a sub-agent handed `manage_memory` would otherwise write memory in exactly
the runs that forbid it. The gate is computed at the compaction call site and passed in.

Since all three ways of compacting share one path, each has to answer for itself. Automatic
compaction computes the gate from the run's own options. `summarize_context` inherits that
same answer, which the loop puts on the tool context beside `compactConversation` — calling
the tool instead of waiting for the 80% mark should not change whether facts reach memory.
`/compact` does not extract: it is invoked from the chat layer, which holds neither flag and
so cannot answer for the run it is compacting.

**It is best-effort.** Any failure is logged and swallowed: memory extraction can never fail
or block compaction, which is the load-bearing step. And like the summary, the transcript it
reads is untrusted — the extractor treats "remember this" directives inside the conversation
as data to assess, not instructions to obey.

Window size comes from the model catalog (models.dev), falling back to 128k when unknown ,
so the threshold tracks the actual model rather than a guess.

**Local providers are the exception, and getting this wrong is the worst failure mode there
is.** A cloud provider honours the window its catalog advertises. Ollama does not: it loads
the model with whatever `num_ctx` the request carries, or with the server's
`OLLAMA_CONTEXT_LENGTH` default. `qwen3.6:27b` advertises 262144 tokens and is routinely
served at 131072 or less. Accounting against the advertised number means Jazz compacts long
after the server has started dropping the middle of the conversation, and the agent keeps
answering from a context it no longer has.

For `ollama`, a pinned `llm.numCtx` is sent as the request's `num_ctx` and sets the runtime
window. For `llamacpp`, the pin is an accounting override; otherwise Jazz uses the loaded
server's `/props` value. For `vllm` and `sglang`, Jazz refreshes the served ID and uses `max_model_len` from their `/v1/models`
card when available. A vLLM or SGLang `llm.numCtx` pin limits Jazz's context accounting to the smaller
of the pin and the served limit; it does not change the server context setting.
An unpinned Ollama agent gets a warning at run start rather than a silent assumption,
because Ollama exposes a loaded model's window on `/api/ps` but has no endpoint for the
server default before anything is loaded.

The catalog says nothing reliable about a local server. models.dev carries no `ollama`,
`llamacpp`, `vllm`, or `sglang` provider, so a local model either resolves to the 128k
unknown-model placeholder or matches a hosted listing of the same weights by name. Those
listings disagree with each other: `qwen3.8-27b` appears at 262144 on most hosts and at
120000 on one. So a window the server reports is never capped by the catalog: vLLM serving
262144 is accounted at 262144. The catalog maximum only caps a `numCtx` pin the server has
not confirmed, and the placeholder never caps anything: a pinned window above it is
honoured, because the user pinned it and configured the server to serve it.

### The per-agent ceiling

`config.llm.maxContextTokens` caps the window for _any_ provider. It is the answer to "this
agent should never carry more than 60k tokens of history, even though the model would hold
200k": useful for keeping cost and latency predictable, for models whose quality sags long
before their advertised limit, and for staying under a provider tier's real limit.

The ceiling only ever lowers the window: `min(runtime window, maxContextTokens)`. Asking for
more than the server will honour is ignored, because that is exactly the silent-truncation
failure above. Everything downstream then follows the capped number: the warning, the
compaction threshold, the summarizer's recent-message budget, and `/context`.

Set it with `jazz agent edit` → **Max Context Tokens**; leave the prompt blank to remove the
ceiling and go back to the model's own window.

### The ladder, cheapest rung first

Four mechanisms share one budget, escalating by cost.

| Rung               | Fires at | Costs              | Effect                                                                                                     |
| ------------------ | -------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Clear tool results | 50%      | nothing            | The last five tool cycles stay verbatim. Older results of 256+ tokens become a pointer (or a re-run stub). |
| Warn               | 70%      | nothing            | User _and_ agent are told; the agent is nudged to consolidate                                              |
| Compact            | 80%      | one LLM call       | Older history summarized into the running summary                                                          |
| Trim               | 95%      | nothing, but lossy | Messages dropped unsummarized: the floor, not the path                                                     |

Clearing costs no tokens, but it is not free: a stubbed result is evidence the model no
longer has in front of it, and every rewrite moves the prompt-cache prefix. So below 50%
(`CONTEXT_CLEAR_THRESHOLD_RATIO`) nothing is touched, and above it each result is
rewritten at most once (`cleared` sticks), so the prefix only jumps when a result
actually ages out of the protected window.

When a `compact.tools` plugin is enabled, it replaces the deterministic stubbing at this rung:
the plugin decides keep / truncate / drop per old, large result, and Jazz applies that (still
only replacing content, never removing a message) or falls back to the deterministic clearer on
abstain, error, or timeout. The same pre-pass runs on manual `/compact` before the summarizer,
since that path skips the live clear rung. Either way the first reclaim in a run prints a green
notice crediting the plugin, and the per-result decisions are logged (`Compaction plugin
tool-result decisions`). See [Plugins](../configure/plugins.md).

Before stubbing, Jazz tries to write the original body under
`~/.jazz/work/<agent>/<conversation>/tool-results/<tool_call_id>.txt`. The
placeholder then names `retrieve_tool_result`. If the write fails: read-only
CI images, locked-down containers, a Telegram host that can read but not write ,
the run continues and the placeholder says to re-run the original tool. Missing
retrieves fail the same way. The conversation never depends on a writable disk.

A result too long for its context budget is cut when it is first added to the conversation.
When the run has `retrieve_tool_result`, the whole result is written to the same path at once,
with a `<tool_call_id>.provenance.json` beside it when it holds untrusted content, and a line
after the cut result names the call to read it. `retrieve_tool_result` returns a long body a page
at a time by `offset`, and frames every page with the stored provenance. Sub-agents' whole answers
are kept in the same store under `subagent-<id>-<started>` ids.

The protected window runs from the assistant message that opened the fifth most
recent tool cycle through the end of the list (`PROTECTED_TOOL_CYCLES`). One cycle
was not enough: a model that reads a file, then lists a directory, then edits has
already lost the file by the time it edits, and refetches it every turn.

Tool results are cleared by replacing content and keeping the message, so the
assistant/tool pairing survives. Deleting the message would orphan the `tool_calls` that
referenced it and provoke a provider error.

### What the budget counts

Tokens are messages **plus per-request overhead**: tool schemas and provider scaffolding.
MCP server schemas no longer count toward this by default: they're a `deferred`-tier category
(see [Tools](../concepts/tools.md)), so only the always-on
tool set's schemas are in the request until `search_tools` fetches one. Overhead is measured,
not estimated: after each call, `promptTokens − estimatedMessageTokens` is the gap, smoothed
per model. Counting messages alone meant an agent believed it was at 79% when it was at 102%.

### Warn first, compact second

Two thresholds share one budget, both defined in `context-window-manager.ts`:

|          | Warning                                                                   | Compaction                              |
| -------- | ------------------------------------------------------------------------- | --------------------------------------- |
| Fires at | 70% of the budget (`CONTEXT_WARN_THRESHOLD_RATIO`)                        | 80% (`CONTEXT_COMPACT_THRESHOLD_RATIO`) |
| Costs    | nothing                                                                   | an extra LLM call                       |
| Effect   | `context 74% full of 60,000 tokens: will auto-compact soon`, once per run | history is summarized                   |

Both the user _and the agent_ are told. Past 70% the request carries an ephemeral
`[CONTEXT WARNING: …]` line telling the model to record what it needs and consolidate
rather than gather more; past 90% a `[CONTEXT CRITICAL: …]` line telling it to write its
output now. This mirrors the iteration-budget nudge in `buildBudgetPressureMessage`, and the
two are merged into one appended message when both fire.

**After a successful compaction the wrap-up nudges are replaced.** The history has just
been rewritten and space was freed so the original task can continue: telling the model
to "write your final output NOW" at that moment is the opposite of what happened. The
request instead carries `[CONTEXT COMPACTED: …]` asking it to resume from the summary
until the user's request is fully complete. If usage is still above 90% after the
summary, the same message notes that context is still tight, but it does not tell the
model to stop.

The nudge is appended to the outgoing request only: never pushed into `currentMessages`.
A persisted warning would cost tokens exactly when they are scarce, be re-sent every turn,
and eventually be summarized into the very compaction it was warning about.

The warning exists so that compaction is never a surprise: there is a window where you can
still `/compact` on your own terms, narrow the task, or raise the ceiling before the
summarizer decides what to keep. `ContextWindowManager` owns both decisions. `usage()`
returns the current tokens, the budget, and both flags from a single count.

### The iteration budget gets the same treatment

An iteration cap stops a run the same way a dead provider does, so it also warns before
it fires. On a bounded run, crossing 50%, 70%, or 90% of `maxIterations` fires
`onIterationPressure` once per threshold: `iteration budget 70% used (70/100) - run stops
at the limit, type 'continue' to keep it going`, followed by `onIterationLimit` at the
cap. The ramp is user-visible only — the model already receives ephemeral
`[ITERATION WARNING: …]` / `[ITERATION CRITICAL: …]` lines via `buildBudgetPressureMessage`
at 70% and 90%, and sub-agent runs (`internal`) are skipped so a delegation fan-out does
not spam the parent conversation. A run with no cap (`Infinity`, the attended default)
never warns: there is no limit to warn about.

---

## Working state outlives the context window

Compaction is lossy by design, so the things that must not be lost are written outside the
conversation, under `~/.jazz/work/<agent>/<conversation>/`:

- **`journal.jsonl`**: every compaction appends its summary here _before_ it enters
  context. No extra LLM call and no extra tokens: it persists something already paid for.
  Append-only, one JSON object per line, so a crash damages at most the final record.
- **`state.json`**: the agent's own record of where the work stands, written through
  `update_work_state`. Patched field by field, so a small correction cannot drop the rest.

This is deliberately **not** memory. Memory holds what stays true about a person or project
for weeks, and its own instructions tell the agent not to store one-off task details ,
which is exactly what compaction destroys. "They prefer Bun over npm" is memory; "3 of 5
routes migrated, auth fails on token refresh" is work state, and it is discarded when the
work ends.

Two things read it back:

- **Resuming a conversation** loads post-compaction messages, so whatever compaction
  dropped is simply absent. The journal is folded back in as a bounded (~2k token)
  preamble, framed as claims to verify rather than fact: progress records are written
  mid-task and are habitually optimistic about what was finished.
- **Compaction itself** is told what work state already holds, so the summary covers what
  the transcript adds instead of restating the plan.

Todos carry a `verifiedBy` field alongside their status, and the prompt asks for it
whenever something is marked completed. An agent that marks its own work complete on the
strength of having written it turns the record into a confident lie for whoever picks the
work up next; a completed todo with nothing in `verifiedBy` says plainly that nobody
checked. Work state used to keep a second, parallel list of the same work under a
different vocabulary: the idea survived, the duplicate list did not.

Inspect or discard it with `/work` and `/work clear`. Journals are capped per conversation
and pruned oldest-first, since the newest record is the one describing where the task is.

---

## Tool results are reformatted before storage

The largest single lever on context in a long run isn't the conversation: it's tool
output. Every tool result passes through `formatToolResultForContext` before it's appended,
which shapes it for a model reader rather than dumping a raw payload.

Result sizes are also recorded per tool name in the run metrics, so `/context` can show you
which tool is actually eating your window. Usually it's one, and usually it's a surprise.

---

## Inspecting it live

| Command    | Shows                                                  |
| ---------- | ------------------------------------------------------ |
| `/context` | Current tokens, window size, and the biggest consumers |
| `/compact` | Force compaction now                                   |
| `/cost`    | Tokens and USD for this session, including sub-agents  |

And in the logs: `Conversation context approaching limit`, `Context compacted successfully`
(with tokens saved), and trim decisions at debug level.

---

## Related

- [Agent loop](./run-lifecycle.md): where compaction and trimming sit in an iteration
- [Delegation](../concepts/agents.md#delegation): the other way to keep the parent's context small
- [Architecture](./architecture.md): where context management sits in the harness
