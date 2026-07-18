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

## Judge calibration

`evals/judge/calibration.jsonl` holds human-labeled rows; the runner checks the
judge correlates with humans (Pearson ≥ 0.7) before trusting rubric scores.
