# UI ownership qualification, 2026-10-01

Absolute smoke budgets pass. Relative pipeline qualification remains **pending**:
the full matched run and the focused alternating reproduction both fail Ink
latency gates. No budget was relaxed and no failed observation was discarded.
These local results do not establish that CI passes or that the original user
freeze persists; the user reports it has not recurred since the installed update.

## Revisions and measurement contract

Baseline production is `93a6bdd16d353f60470556a5b8f613c05da60409` in
`transcript-freeze`. The earlier memory, row and startup reports measure runtime
`e2958af9` plus `c19ddcd0`. Corrected pipeline, parser, filesystem and focused
runs measure the rebased equivalent runtime `09dd4b47`, with reader foundation
`70d06969`, at tree `aaffda863c9efa58f58a067b4a1c470d45ddc347`. The reader-only
boundary correction does not participate in these workloads.

All reports use macOS ARM64, Bun 1.4.2, offline synthetic fixtures and styled
output: `BENCH_PROFILE=smoke JAZZ_OFFLINE=1 NO_COLOR='' FORCE_COLOR=3`.
Pipeline base then head ran serially; focused runs alternated base/head in three
fresh-process pairs. Root avoided heavy checks during those runs. This is a
local machine measurement, not a calibrated idle-host or cross-platform study.

The corrected pipeline suite, runner, harness, corpus and memory worker were
byte-identical between checkouts. SHA-256 of the corrected pipeline suite is
`2b9986f1213eceff0161ee03535197be728bd09809f75bef3e80a9641fabcd6f`.
Fixture differences are deliberate: the old string-plus-metadata store contract
versus the semantic stream object, and baseline continuous `renderer.start()`
versus head demand rendering. Each matches its production revision.

Each delta case measures its first frame once and all 32 subsequent frames.
Nothing is discarded as warmup. Three-process reports take the median of each
process summary, rather than pooling frames. The previous two-frame case made
both p50 and p95 equal the slower frame; its labels did not distinguish a cold
transition from steady rendering. Startup still has only two observations per
process, so its reported p95 is not a strong tail estimate.

## Gate evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Combined head absolute smoke budgets | Pass, 68 rows | [absolute.head.json](absolute.head.json) |
| Transcript row comparison | Pass | [base](rows.base.json), [head](rows.head.json) |
| Corrected pipeline comparison | Fail, 3 metric gates | [base](pipeline.base.json), [head](pipeline.head.json) |
| Earlier memory lifetime comparison | Fail, Ink30 p50/p95 | [base](memory.base.json), [head](memory.head.json) |
| Focused Ink30 lifetime comparison | Pass | [base](focused-memory.base.json), [head](focused-memory.head.json) |
| Focused pipeline comparison | Fail, 4 metric gates | [base](focused-pipeline.base.json), [head](focused-pipeline.head.json) |

The full corrected pipeline failure is unicode1k steady p95 **6.0564 → 9.5040 ms**
and unbroken1k first p50/p95 **2.6758 → 5.4832 ms**. In the focused three pairs,
unicode steady improves (**10.4245 → 5.8176 ms** p95), but unbroken first still
fails (**6.7742 → 28.5958 ms** p50/p95), as does steady (**3.6416 → 5.1925 ms**
p50; **5.7929 → 11.5927 ms** p95). Head unbroken first observations are
28.5958, 3.4760 and 32.7530 ms. The reports preserve every first and steady frame.

The earlier Ink30 lifetime median was **3396.4794 → 5133.0180 ms**. Fresh focused
base/head pairs are **3658.7/3212.6**, **3261.0/3112.2**, **4322.2/4043.3 ms**:
head is faster in all three. This weakens the earlier timing attribution; it
does not erase that report. Child lifetime includes GC and teardown. The
source-retention safeguards were unchanged.

## Phase diagnostic and remaining uncertainty

A single instrumented pair records publication, presentation projection, React
layout/commit completion, native render, stdout writes and flush completion.
It overlapped root's final checks and is **ordering evidence only**, not another
performance qualification: [base](phase-diagnostic.base.json),
[head](phase-diagnostic.head.json). Source snapshots are retained as
[focused runner](focused-runner.ts.txt) and [phase observer](phase-observer.ts.txt).

Before each measured marker becomes visible, both revisions show exactly one
layout, one immediate native render and the same output byte count, for all 66
updates. The unbroken first delta takes 8.1126/6.3211 ms here. Head projection
finishes at 0.4037 ms, output is written at 5.6265 ms, and flush takes 0.1268 ms.
This path uses Ink's Static immediate-render escape before the flush wait;
the diagnostic does **not** establish a 30 fps throttle explanation for the
earlier 28–33 ms frames. Additional classic projection work was 0.0717 ms median,
0.2462 ms maximum for unbroken. No consistent extra head frame is observed.
The remaining failure needs tracked phase reproduction before a production fix.

Independent sampling counterevidence: [PR1 CI comparison](https://github.com/lvndry/jazz/actions/runs/36862576588/job/110370122374)
failed OpenTUI unicode50k **35.4975 → 49.2403 ms** under the old two-frame case,
despite unchanged production UI code in that PR. This motivates the sampling
correction; it does not invalidate the corrected focused failures. Two attempted
Jazz reviews returned no verdict (provider credits exhausted; timeout), so
neither is counted as review evidence.

## Resources and startup

OpenTUI100 prose retained heap falls **64.2 → 22.4 MB** and peak RSS
**917.1 → 784.6 MB**; retained cells **1,485,161 → 260,267**. Sampled transient
cells increase **4,672,515 → 5,331,125**. Smoke runs meet the 1 GiB RSS and
64 MiB post-clear heap ceilings.

The separate [extended report](memory.head-500.json) is **one sample**, excluded
from `absolute.head.json`. OpenTUI500 prose peaks at **1,198,325,760 bytes** and
OpenTUI100 stress at **1,250,263,040 bytes**, both above the smoke ceiling.
Bounded layout caches do not make total history/native memory constant.
Negative post-clear values are deltas from warmed heap, not negative heap sizes.

[Startup](startup.head.json) medians are source `--version` **72.8569 ms**,
compiled `--version` **31.3218 ms**, OpenTUI fresh/warm accepted draft
**1016.1888/1113.9943 ms**, and Ink **636.4887/790.3248 ms**. These are reported
p50 medians, not means. Parser50KB p95 is **1.7165 ms**; 10,050-file approval
scan p95 is **301.6694 ms**. Release binary size was not remeasured in this batch.

## Reproduce

In each prepared checkout, with the matching harness copied to baseline:

```sh
env BENCH_PROFILE=smoke JAZZ_OFFLINE=1 NO_COLOR='' FORCE_COLOR=3 \
  bun bench/run.ts ui-pipeline --samples 3 --output pipeline.json
env BENCH_PROFILE=smoke JAZZ_OFFLINE=1 NO_COLOR='' FORCE_COLOR=3 \
  bun bench/run.ts markdown-prose --samples 3 --output markdown-prose.json
env BENCH_PROFILE=smoke JAZZ_OFFLINE=1 NO_COLOR='' FORCE_COLOR=3 \
  bun bench/run.ts filesystem-config-models --samples 3 --output filesystem.json
bun scripts/performance-check.ts pipeline.base.json pipeline.head.json
bun scripts/performance-check.ts --absolute absolute.head.json
```

The focused runner snapshot accepts `pipeline` or `memory` and
`BASE_CHECKOUT`, `HEAD_CHECKOUT`, `QUALIFICATION_OUTPUT` environment variables.
Copy the `.ts.txt` snapshot to a temporary `.ts` file to run it with Bun.
The phase observer takes a checkout path. It depends on Ink 7.1.1 internals,
wraps callbacks without changing scheduling, and retains events after visibility
from cleanup; comparisons above stop at the `visible` event. No provider calls,
private histories or terminal transcript contents are archived.
