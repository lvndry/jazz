# Agent-evaluation prior art

_Research date: 2026-09-25. External facts come from primary sources fetched on this
date (arXiv abstracts/papers, official repos, project sites) and are scoped to those
sources._

## 1. SWE-bench (ICLR 2024, oral)

- **Source**: arXiv:2310.06770 (https://arxiv.org/abs/2310.06770); repo https://github.com/princeton-nlp/SWE-bench; site https://www.swebench.com.
- **Setup**: 2,294 real GitHub issue→PR pairs from 12 Python repos, curated from ~90k PRs; 3-stage curation (repo selection → attribute filter → execution filter: PR must contain tests that fail before and pass after).
- **Oracle**: deterministic — apply the model patch at the base commit, run the PR test suite; resolved = all fail-to-pass (F2P) pass and all pass-to-pass (P2P) still pass. §C.5 adds an outcome taxonomy (resolved / breaking-resolved / partial / WIP / no-op / regression).
- **Metrics**: % resolved, pass@1 (single patch, greedy decoding). Published (paper Table 5, BM25 setting): Claude 3 Opus 3.79%, Claude 2 1.97%, GPT-4 1.96% (25% subset); oracle retrieval: Claude 2 4.8%.
- **Author-stated limitations**: Python-only, text-only; single-shot non-interactive (authors call out the missing execution-feedback loop); contamination mitigated but not eliminated (temporal analysis §C.4 shows no consistent issue-year correlation).

## 2. Terminal-Bench (ICLR 2026)

- **Source**: arXiv:2601.11868 (https://arxiv.org/abs/2601.11868; OpenReview https://openreview.net/forum?id=a7Qa4CcHak); repo https://github.com/laude-institute/terminal-bench (TB 2.0: https://github.com/laude-institute/terminal-bench-2); leaderboard https://www.tbench.ai.
- **Setup**: terminal-agent tasks in Docker; TB 2.0 is "a carefully curated hard benchmark composed of 89 tasks in computer terminal environments inspired by problems from real workflows" (abstract). TBv1: ~100 tasks, beta.
- **Oracle**: deterministic task test script on final in-container state; **every task ships with an oracle (reference) solution that must pass the same tests before release** (repo README).
- **Metrics**: task success rate; Terminal-Bench-Core v0.1.1 is the current leaderboard set. Per-model numbers live in the paper/leaderboard (not re-fetched here, deliberately not restated).
- **Author-stated limitations**: v1 beta, still-growing set; 2.0's stated motivation is that prior benchmarks "either do not measure real-world tasks, or are not sufficiently difficult".

## 3. OSWorld (ICLR 2024)

- **Source**: arXiv:2404.07972 (https://arxiv.org/abs/2404.07972); site https://os-world.github.io/; repo https://github.com/xlang-ai/OSWorld.
- **Setup**: 369 tasks (361 excluding 8 network-dependent Google Drive tasks) on **real desktop VMs** (Ubuntu, Windows, macOS); screenshots in, mouse/keyboard out.
- **Oracle**: **134 execution-based evaluation functions** verify resulting environment state — no LLM judge.
- **Metrics**: task success rate. Published (abstract): human baseline **72.36%** vs best model **12.24%**.
- **Author-stated limitations**: external-network tasks unstable → excluded from headline numbers; real environments drift over time (reproducibility threat) — community response: the **OSWorld-Verified** stable-task subset.

## 4. tau-bench (Sierra, arXiv 2024)

- **Source**: arXiv:2406.12045 (https://arxiv.org/abs/2406.12045); successor repo https://github.com/sierra-research/tau2-bench.
- **Setup**: three-party interaction — tool-calling agent, **LM user simulator** (gpt-4o default, hidden task description), deterministic environment (DB + APIs + domain policies). tau-retail: 115 tasks, 500 users, 50 products, 1,000 orders; tau-airline: 50 tasks, 500 users, 300 flights, 2,000 reservations. Table 4 inventories the APIs (retail 7 write + 6 read + 2 non-DB; airline 6 write + 5 read + 2 non-DB).
- **Oracle**: fully deterministic — final **database state** compared to expected state AND required substrings present in agent messages; no LLM judge.
- **Metrics**: **pass^k** — must pass all k independent trials (reliability, not peak). Published: gpt-4o pass^1 ≈ 61% retail / ≈ 35% airline, **pass^8 < 25% retail**; per-task rates used ≥ 40 trials.
- **Author-stated limitations**: domains deliberately simplified vs real operations; user-simulator fidelity bounded by the simulator model; quantity/quality trade-offs in task construction.

## 5. GAIA (arXiv 2023)

- **Source**: arXiv:2311.12983 (https://arxiv.org/abs/2311.12983); leaderboard https://huggingface.co/gaia-benchmark.
- **Setup**: 466 questions (166 dev + 300 test, test answers **withheld**) needing web browsing, file handling (PDF/image/audio), code execution, multi-step reasoning; 3 difficulty levels.
- **Oracle**: **exact string match** of the `FINAL ANSWER:` line against ground truth; no partial credit, no judge.
- **Metrics**: accuracy. Published (abstract): humans **92%** vs GPT-4-with-plugins **15%**; GPT-4 with web browsing < 30% level 1, 0% hardest level.
- **Author-stated limitations**: web content is dynamic so some ground-truth answers can rot; withheld test split means no local self-scoring.

## 6. AgentBench (ICLR 2024)

- **Source**: arXiv:2308.03688 (https://arxiv.org/abs/2308.03688); repo/leaderboard https://github.com/THUDM/AgentBench.
- **Setup**: **8 environments** (Linux OS, SQLite DB, knowledge graph, digital card game, lateral-thinking puzzles, ALFWorld, WebShop, Mind2Web); multi-turn; all in Docker. Original: 27 LLMs, **269 dev + 1,091 test**.
- **Oracle**: environment-native deterministic signals — success rate (OS, DB, LTP), F1 (KG), reward (DCG, WebShop), game progress (ALFWorld), step success rate (Mind2Web). No LLM judge in core tracks.
- **Metrics**: per-environment metrics; headline finding: commercial models outperform open-source, gaps largest on long-horizon multi-turn tracks (per-model numbers not re-fetched here).
- **Author-stated limitations**: **test set closed** (anti-contamination); multi-turn eval time/cost-prohibitive at scale; a model's ability to learn environment API/tool _descriptions_ is entangled with agent capability.

## Cross-cutting summary

| Benchmark      | Interface             | Oracle                           | Primary metric      | Scale                |
| -------------- | --------------------- | -------------------------------- | ------------------- | -------------------- |
| SWE-bench      | patch (text)          | test suite (F2P/P2P)             | % resolved (pass@1) | 2,294                |
| Terminal-Bench | terminal              | test script + oracle solution    | task success        | ~100 / 89            |
| OSWorld        | GUI VM                | 134 execution-based state checks | task success        | 369                  |
| tau-bench      | tool-calling dialogue | DB state + required substrings   | pass / pass^k       | 165                  |
| GAIA           | assistant toolbox     | exact answer match               | accuracy            | 466                  |
| AgentBench     | 8 envs, multi-turn    | env-native tests/rewards         | per-env metric      | 269 dev + 1,091 test |

## Practices

**Adopt (with rationale):**

1. **Deterministic state oracles as the primary grader.** All six avoid LLM judges for the pass/fail decision. Jazz's existing `checks.ts` already grades on deterministic state/constraint checks while `judge.ts` is secondary (and calibration-gated), which is consistent with this practice.
2. **Reliability metric alongside pass@1.** tau-bench's pass^k (gpt-4o pass^8 retail < 25%) is the design that exposes flakiness. Adopted: each difficulty tier in `sampleReport` reports Pass^k, the fraction of scenarios whose every sample passed.
3. **Oracle-solution validation for every new scenario** (Terminal-Bench practice). Adopted: `tasks/adversarial/adversarial.test.ts` applies each scenario's golden end state and checks it passes, and applies each trap and checks it is flagged, before any model run.
4. **Anti-contamination via authored, deterministic task sets** (AgentBench closed test, GAIA withheld answers): scenarios are authored and the model never sees the oracle before the run.
5. **Outcome taxonomy beyond a single rate** (SWE-bench §C.5). Partly adopted: each sample records pass/fail, the oracle's detail, safety violations, and whether the rollout errored; a resolved / partial / regression classification is not recorded yet.

**Reject (with rationale):**

1. **LLM-as-primary-judge** for goal outcomes — contradicts all six and our independent-oracle constraint; the judge stays for rubric/style only, gated on calibration.
2. **Single-trial success as the validation metric** — the goal is improvement validated over runs; single pass@1 cannot evidence it (tau-bench evidence).
3. **Live-web ground truth** in the adversarial set — GAIA shows web content rots; OSWorld shows environments drift; scenarios must use deterministic offline fixtures (cassettes) so paired baseline/final runs are comparable.

**Gaps:** Terminal-Bench 2.0 and AgentBench current per-model leaderboard numbers were not re-fetched.
