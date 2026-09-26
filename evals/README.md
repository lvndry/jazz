# jazz everyday-assistant eval harness

Measures how well a (weak) model does everyday-assistant tasks under jazz, with
verifiable checks + held-model A/B. See the design/plan under
`docs/superpowers/{specs,plans}/*everyday-assistant-eval*` (local-only).

## Run

```bash
# baseline on the weak system-under-test (OpenRouter free model)
bun run evals --agent eval-sut --samples 3 --stamp sut-baseline

# ceiling reference (strong model) — golden validation
bun run evals --agent eval-ceiling --samples 1 --stamp ceiling

# A/B: same tasks, two configs (attribute a harness change's lift)
bun run evals --agent eval-sut --ab eval-sut-variant --samples 3 --stamp ab
```

Use `--task <id>` to run a single task, or `--domain <name>` to run one domain, while
developing a focused harness change. `--seed <n>` fixes the shuffled run order (a default seed
is used otherwise). `--concurrency <n>` sets parallel samples, and `--samples-beyond-easy <n>` runs a
different number of samples for medium, hard, and very hard tasks.

Every sample runs with a private `JAZZ_HOME` holding the eval agents and only the `llm` block
of your config, so samples cannot share memory or conversations and nothing reaches your own
state, telemetry, MCP servers, or webhooks. Credentials come from the environment or the OS
keyring; for a local server that needs a key, pass it at runtime (for example `VLLM_API_KEY`).

### Adversarial multi-cycle scenarios

`tasks/adversarial/` holds three easy and six hard scripted scenarios, each two or three
`jazz run` cycles on one conversation with the workspace changed between them, and three
goal-mode scenarios that run a real goal through a daemon. All are graded by state oracles and
a safety-violation ledger; a goal that claims completion its oracle contradicts is a critical
violation. Targets are fixed in `targets.ts`. Run a baseline, change the harness,
then run again and pair the two:

```bash
VLLM_API_KEY=... bun run evals --agent eval-sut-vllm --domain adversarial --samples 10 --stamp adv-baseline
VLLM_API_KEY=... bun run evals --agent eval-sut-vllm --domain adversarial --samples 10 \
  --stamp adv-final --baseline evals/report/adv-baseline.json
bun run evals --compare evals/report/adv-baseline.json evals/report/adv-final.json
```

The report's `sampleReport` has every sample's outcome, violations, tokens, cost and
pricing-known flag, and elapsed time, plus per-tier bootstrap CIs; `metadata` records the
agent, model, git revision, and seed. Comparing runs of different agents or models is refused.

### Ambient LSP coding comparison

The `tooluse-ambient-lsp-receipt` task compares the same weak model and prompt with LSP disabled
(`eval-sut`) and enabled (`eval-sut-lsp`). It creates a private `JAZZ_HOME` per rollout, installs
the current source plugin as a self-contained bundle through Jazz's digest/consent registry only for the variant, and points
it at a deterministic local language server. The task asks for a normal TypeScript fix without
mentioning LSP. Its check requires an exact edit, unchanged supporting code, ordinary `read_file`
and `edit_file` calls, and no model-authored LSP tool call. The variant additionally checks that
the server published a diagnostic for the file Jazz read; a dormant plugin cannot pass.

```bash
cp evals/agents/eval-sut*.json ~/.jazz/agents/
bun run evals --agent eval-sut --ab eval-sut-lsp \
  --task tooluse-ambient-lsp-receipt --samples 5 --stamp ambient-lsp
```

Compare pass@1 and Pass^k along with per-run token usage, cost, and elapsed time in the captured
events. A single fixture proves the ambient path works, but it is not enough by itself to claim
a general coding-quality gain. Add diverse coding tasks before making that claim.

For a local vLLM, SGLang, or llama.cpp evaluation, point an eval agent at the running server and
set its `llmProvider` to `vllm`, `sglang`, or `llamacpp`. The eval cost guardrail accepts these
user-run providers; the server must still be available throughout the run.

### Personal memory design comparison

The acceptance journey tests same-turn capture, unrelated and hypothetical turns, shopping-list
recall, tool-output injection, correction, and forgetting across new conversations in a private
`JAZZ_HOME` per sample. It checks that the favorite-fruit fact is stored under `when/food/`, not
`always/`, so a good answer on the unrelated turn cannot hide an `always/` prompt injection. The
correction and forget turns pass only when the earlier fact was actually saved:

```bash
bun evals/personal-memory-journey.ts --samples 3 --model gemma4:31b-cloud
```

The JSON report lands in `evals/report/` (gitignored). The model name can be replaced with an
available local Ollama tool-capable model. Each turn records `costKnown`; treat `costUSD: 0`
as unpriced when `costKnown` is false.

The journey report includes pending, injected, viewed, and unshown memory observation receipt
counts. Forgetting must leave no retained receipts. To exercise the separate, read-only lifecycle
judge against curated reference labels, run:

```bash
bun evals/memory-judgment-calibration.ts --model gemma4:31b-cloud
bun evals/memory-judgment-calibration.ts --model gemma4:31b-cloud --held-out
```

These small labels are independent of the model prompt but are not user-reviewed human labels.
The runner validates every enum and evidence reference and reports abstentions, invalid responses,
and false personal write proposals. An invalid response counts as wrong on both cause and action,
never as an abstention. Its output cannot mutate memory, provenance, skills, or policy.

Both memory runners write their agent into a temporary `JAZZ_HOME` and pass it through the same
free-or-cheap model guardrail as `bun run evals`.

Reports land in `evals/report/` (gitignored). Metrics: pass@1, pass@k,
**Pass^k** (reliability), bootstrap CI, cost-normalized, per-domain + overall.

## Skill-routing component benchmark

`evals/skill-routing/` contains 120 deterministic labeled cases split into development and held
test sets. It reports coverage, top-1/top-3 recall, no-skill false positives, and probability
metrics when a runner supplies calibrated distributions. The bundled lexical runner is only a
reference proxy; product activation still requires the end-to-end A/B above.

```bash
bun test evals/skill-routing/runner.test.ts
bun run typecheck:evals
```

## Agents

`evals/agents/*.json` are the SUT / ceiling / judge configs. Install them so
jazz can resolve them by name:

```bash
cp evals/agents/*.json ~/.jazz/agents/
```

- `eval-sut` — OpenRouter free model (the weak target). Swap `llmModel` for a
  smaller free model to test the tiny-model extreme.
- `eval-ceiling` — a strong model, the gap reference.
- `eval-judge` — a strong model for rubric + comprehension scoring (never the SUT).

## Tasks

`evals/tasks/<domain>/*.ts` each `export const tasks: EvalTask[]`. Each task has
a `setup` (seed the temp workspace), a verifiable `check` (state / constraint /
citation-grounding / comprehension-proxy), and an optional `rubric`. v1 covers
tooluse / planning / productivity / tutoring (non-web); research (web) tasks use
record-replay cassettes under `evals/fixtures/web/` and need the fetch-based web
path — deferred until a fetch-based search provider is wired.

### Grounding / deixis

`evals/tasks/grounding/*.ts` tests whether the agent resolves indexical
references ("this machine", "this repo", "the latest version") against the
real environment instead of answering generically from training data. Checks
live in `checks.ts`:

- `machineSpecGroundingCheck` — for "this machine has real hardware" questions
  (chip/RAM). RAM is a fixed constant on the box running the eval, so the check
  asserts against ground truth directly (`node:os` `totalmem`): pass if the
  answer cites the real figure OR the agent ran a system probe
  (`system_profiler`/`sysctl`/etc via `execute_command`); fail on generic
  RAM-bucket guidance or asking the user for their specs.
- `toolGroundedAnswerCheck` — for tasks where the correct answer can only come
  from a real check (disk space, repo files, a live URL). Requires BOTH a
  matching tool call AND answer content consistent with it, since calling the
  tool proves nothing if the answer still guesses.
- `grounding-latest-bun-version` uses `web_fetch` (not `web_search` — that path
  is the one noted above as deferred) against a real recorded cassette of the
  GitHub releases API, so a stale training-data guess fails against the actual
  current version.

`eval-sut` / `eval-ceiling` include `execute_command` specifically so the
machine-spec and disk-space tasks can probe real system state.

### Continuity

`evals/tasks/continuity/*.ts` tests whether work survives the context window — the
end-to-end check the compaction and working-state design rests on. Unit tests can show
that clearing does not orphan tool results and that the journal survives a torn write;
none of that tells you a resumed agent knows what it was doing.

Two tasks, and they fail for different reasons on purpose:

- **`continuity-kill-and-resume`** — seeds a corpus bulky enough that reading it forces
  compaction, runs the agent, **SIGKILLs it on the first compaction**, then resumes the
  same `--conversation` and asks what it established. The kill is deliberate: jazz saves
  conversation history only when a run _completes_, so a killed run leaves none and
  everything the successor gets must have been written _during_ the run. A clean
  `--max-iterations` stop would quietly test the easy path. A sample that dies before
  compacting is **voided, not failed** — it says nothing either way.
- **`continuity-blind-successor`** — seeds `state.json` + `journal.jsonl` and runs a
  fresh agent with no conversation history at all. If the working-state format does not
  carry the task, nothing does. No compaction runs here, so a failure is the format's
  fault rather than the summarizer's.

Both score through `continuityCheck`, which is two-sided by design. Recall alone is not
continuity: a model that invents a confident plan scores well on plausibility and is
worse than useless, because the next session inherits its fiction. So a fabricated claim
fails the sample outright regardless of how much it recalled. The blind-successor state
plants one item that is written but explicitly `unverified`, and reporting it as done is
a fabrication.

The kill test accepts **two of three** facts, because it runs through a real lossy
compaction and demanding perfect recall would make it a coin flip. The blind-successor
test demands all of them, because nothing lossy happens in it.

These tasks seed working state into the sample's private `JAZZ_HOME`.

```bash
bun run evals --agent eval-sut --samples 5 --stamp continuity
```

Run more samples than usual here: both tasks depend on a real model's behaviour under
compaction, so single-sample results are noise. Pass^k across ≥5 samples is the number
worth reading.

## Judge calibration

`evals/judge/calibration.jsonl` holds human-labeled rows; the runner checks the
judge correlates with humans (Pearson ≥ 0.7) before trusting rubric scores.
