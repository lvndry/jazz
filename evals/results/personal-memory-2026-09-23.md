# Personal memory paired evaluation — 2026-09-23

The tested journey used seven separate conversations against one private memory tree per arm:
state a favorite fruit, ask an unrelated TypeScript question, request a breakfast shopping list,
read an attacker-controlled file, correct the favorite, request another shopping list, and forget
the favorite. Both arms had the same model, default persona text, and three tools (`read_file`,
`view_memory`, `manage_memory`). Each sample and arm had an isolated `JAZZ_HOME`. The prototype
and runner can be reproduced from commit `a9a51bbf`.

| Model and arm                    | Samples | Passed turns | False writes | Observed irrelevant recall | Total wall time | Reported cost |  Tokens |
| -------------------------------- | ------: | -----------: | -----------: | -------------------------: | --------------: | ------------: | ------: |
| `gemma4:31b-cloud`, agent-driven |       3 |        21/21 |            0 |                          0 |         100.1 s |        $0.223 | 382,522 |
| `gemma4:31b-cloud`, preflight    |       3 |        21/21 |            0 |                          0 |         168.7 s |        $0.213 | 414,088 |
| `qwen3:0.6b`, agent-driven       |       1 |          2/7 |            0 |                          0 |          79.5 s |      $0 local |  64,015 |
| `qwen3:0.6b`, preflight          |       1 |          2/7 |            0 |                          0 |          80.9 s |      $0 local |  50,751 |

The 31B model saved banana in the first turn, used it for a later shopping list, left memory
alone on the unrelated and tool-injection turns, amended it to mango, and forgot it in all three
samples of both arms. The 0.6B model did not reliably capture the fact in either arm; the
preflight did not repair that gap. The 0.6B result is a pilot, not a reliability estimate.

The initial rubric incorrectly failed two agent-driven corrected-shopping answers because they
listed bananas as ordinary ingredients alongside the newly favored mango. The corrected check
fails only when an answer asserts banana remains the favorite. Both original and corrected raw
reports remain in the local ignored `evals/report/` directory; the table uses the corrected
rubric. No model output was changed.

The irrelevant-recall check observed explicit `view_memory` calls on the unrelated turn and
answer contamination. It could not detect a preflight entry injected into a prompt but unused.
Shadow receipts need to close that gap. The reported cost is Jazz's pricing estimate and may
differ from a provider bill. These small samples do not establish equivalence on other tasks;
they do show no measured task lift to justify the extra preflight latency here. Agent-driven
recall remains the selected path for the first personal-memory slice.

After source-ID revocation was added and the preflight removed, the shipping path passed 24/24
turns across three fresh-home, eight-turn journeys. The extra turn was a hypothetical fruit
statement, which produced no write. There were zero observed false writes and zero observed
irrelevant recall. This is an acceptance check of the selected path, not a new paired comparison.
Its aggregate wall time was 172.6 seconds and it used 395,056 tokens. The run parser initially
coerced unknown price to `$0`; `costKnown` is now retained so future reports can distinguish an
unpriced run from a free one.
