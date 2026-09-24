# Memory observations and judgment check — 2026-09-23

The original agent-driven personal-memory journey passed its answer rubric while injecting a
favorite-fruit entry from `always/` on unrelated turns. That exposure was invisible to its
`view_memory`-call and answer-contamination proxy. Capture requires an explicit relevance topic
for a new entry, and the first discovery call lists topic file paths. Three fresh-home journeys
then passed 24/24 turns with the fruit under `when/food/`.

Memory observation receipts record each scope-eligible entry at every model request, including
entries never shown. In a separate isolated eight-turn journey after receipt locking, 8/8 turns
passed:

| Turn                              |   Receipts | Injected exposures | File-view exposures | Eligible but unshown |
| --------------------------------- | ---------: | -----------------: | ------------------: | -------------------: |
| Unrelated TypeScript task         |          1 |                  0 |                   0 |                    1 |
| First breakfast shopping list     |          3 |                  0 |                   1 |                    2 |
| Corrected breakfast shopping list |          3 |                  0 |                   1 |                    2 |
| Forget request, after deletion    | 0 retained |                  0 |                   0 |                    0 |

The scope erase test also completes an in-flight receipt _after_ forgetting and confirms that it
cannot restore the old observation. A directory listing or cleared result does not count as a file
exposure. A pending receipt survives an uncompleted request as unknown. The store keeps only IDs,
paths, source refs, timestamps, and hashes, not raw transcript or tool text. A forget operation
clears the whole scope's observation window, including other entries' receipts.

The smoke journey took 121.5 seconds. One hypothetical turn took 84.5 seconds because the live
model response was unusually slow; this run is a correctness check, not a reliable latency
comparison. The earlier paired design comparison is in
[personal-memory evaluation](./personal-memory-2026-09-23.md).

## Bounded judgment calibration

The offline judge receives a goal and source-labeled evidence and returns strict structured data.
The validator checks enum values, existing evidence refs, direct-user authority for personal facts,
and the action boundary: `record` is invalid for a memory gap or unknown cause. It never writes
production memory, provenance, receipts, skills, or policy. The curated labels were authored
separately from the judge prompt, but have not been reviewed by a human user.

| Label set                                   | Cases | Cause labels correct | Actions correct | False personal write proposals | Notable error                                                                      |
| ------------------------------------------- | ----: | -------------------: | --------------: | -----------------------------: | ---------------------------------------------------------------------------------- |
| Development, before the tighter action gate |    12 |                   10 |               8 |                              1 | The model proposed `record` for a memory gap; the validator rejects it.            |
| Held-out, after the gate and prompt update  |    10 |                    9 |               9 |                              0 | It treated memory whose read tool was unavailable as an actionable memory gap.     |
| Held-out, repeat with the same gate         |    10 |                    8 |               9 |                              0 | The tool-unavailable case recurred; it also called quoted web text an agent error. |

The first held-out run cost an estimated $0.060 over 104,546 tokens; the repeat cost $0.033
over 56,082 tokens. These numbers predate the fix that scores an invalid response as wrong rather
than as a correct `unknown`/`abstain`, so they may be inflated and need a re-run. The differing
cause accuracy and small, non-human-labeled sample are enough
to keep automatic lesson changes and skill proposals off.
The observation receipts deliberately leave relevance `unknown` and award no `helped`, `failed`, or
`missed` credit. More diverse user-reviewed labels and independently checked downstream task
outcomes are needed before any promotion gate can be considered.
