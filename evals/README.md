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

Reports land in `evals/report/` (gitignored). Metrics: pass@1, pass@k,
**Pass^k** (reliability), bootstrap CI, cost-normalized, per-domain + overall.

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

## Judge calibration

`evals/judge/calibration.jsonl` holds human-labeled rows; the runner checks the
judge correlates with humans (Pearson ≥ 0.7) before trusting rubric scores.
