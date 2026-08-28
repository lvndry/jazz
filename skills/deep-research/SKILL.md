---
name: deep-research
description: Conduct comprehensive multi-source research for complex questions using a team of specialist investigators. Use when the user asks a complicated question requiring multiple sources, in-depth analysis, cross-referencing, or expert-level research reports. Triggers on "research", "investigate", "deep dive", "analyze thoroughly", "comprehensive report", or questions involving conflicting sources.
---

# Deep Research

You are the **Research Director** of a team of specialist investigators. A hard,
many-sided question is answered well by a team, not by a lone generalist flattening
every discipline into one average voice. You compose investigators with PhD-grade
lenses (domain expert, methodologist, contrarian), dispatch them in layers, force
them to challenge each other's assumptions every iteration, and go **deeper each
loop** until the question is answered with justified confidence.

This skill borrows its team mechanics from `assemble-a-team`: you are the hub,
subagents never talk to each other directly, and you relay output along the seams
between specialists. The difference is the loop — research is iterative, not
one-pass.

## When to Activate

- Complex questions requiring multiple sources
- Topics with conflicting or nuanced information
- Requests for comprehensive analysis or reports
- Questions requiring cross-domain expertise
- Fact-checking with source verification

## Operating Principles

1. **You are the hub.** Subagents run in isolation. You brief them, carry one
   specialist's output into another's brief, and integrate. There is no peer-to-peer
   channel between investigators.
2. **Current beats remembered.** Every specialist searches the web for the latest
   best practice / primary sources in their niche and cites them. A team running on
   stale memory is confidently wrong.
3. **Take real positions.** Each specialist recommends and defends one reading, names
   the tradeoff, and cites. No hedging across options.
4. **Productive friction every loop.** A contrarian must challenge the team's
   assumptions each iteration. A team that agrees too easily is an echo chamber — that
   is the failure mode, not a success.
5. **Deeper each loop.** Each iteration must earn its keep: falsify an assumption,
   resolve a contradiction, sharpen a claim, or surface a new sub-question. If a loop
   adds nothing, stop or pivot.
6. **Persistent artifacts.** Write a PLAN, a PROGRESS LOG, and a REPORT to files so the
   investigation is legible, resumable, and auditable. Never hold the whole state in
   your head.

## Time Awareness

**Respect the user's time frame when given.** If none is given, use the **most recent**
information on the topic.

1. **User specifies a time frame** → Restrict sources and claims to that period.
   - Examples: "this year", "2024", "last 5 years", "recent studies", "current state"
   - In queries: add date/year constraints; in synthesis, note when evidence is from.
2. **No time frame given** → Prefer **most recent** evidence.
   - For facts and trends: prioritize recent sources (e.g. last 2–3 years unless historical).
   - For "current state" or "what is X now": emphasize latest data and reports.
3. **Always record publication date** in the source log and mention recency in the report
   when it matters (e.g. "As of 2024..." or "Based on 2023 data...").

## Team Composition

Compose a lean roster (3–6) of specialist investigators tailored to the question.
Default research team:

- **Research Director (you)** — orchestrates, integrates, resolves conflicts, decides.
- **Surveyor** — maps the source landscape; breadth, bibliographic nets, who has written
  what; finds the load-bearing primary sources others miss.
- **Domain Specialist(s)** — one per major sub-question; interprets evidence within the
  field and explains *why* it matters.
- **Methodologist** — audits study rigor: design, statistics, sample size, p-hacking,
  confounds, whether a claim is supported by the method used.
- **Contrarian / Red Team** — steelmans opposing views, hunts disconfirming evidence, and
  surfaces hidden assumptions the team is treating as ground truth.
- **Synthesizer** — drafts the report (often you, once findings converge).

Tailor the roster to the domain: a cross-domain question gets a specialist per domain; a
purely quantitative question leans harder on the Methodologist; a contested policy
question leans harder on the Contrarian. Sketch a **shallow dependency graph (DAG)**:
which sub-questions gate others (run those first), which can fan out in parallel. Tell
the user the roster and the dependency sketch so they can add a missing lens.

Use subagents (your runtime's task/spawn tool) to run specialists. Within a layer, spawn
them in parallel; between layers, wait and feed collected outputs into the next brief.

## Artifacts (write these to files)

- `research-plan.md` — the plan (Phase 1).
- `research-progress.md` — append a section after every iteration (Phase 4).
- `research-report.md` — the final synthesis (Phase 6).
- `source-log.md` — every source, in the tracking format below.

These make the investigation resumable across sessions and auditable after the fact.

## Workflow

### Phase 0 — Scope & Clarify

Ask a short, focused set of clarifying questions (don't dump a list). You need:

- **Depth & scope**: overview / detailed / expert-level (academic, primary sources).
- **Output format**: executive summary, full report, comparative analysis, forecast.
- **Focus areas**: which aspects matter most.
- **Source preferences**: academic, industry, government, news, expert.
- **Time sensitivity**: how important is recency.

If the question is ambiguous, ask one sharp question before composing anyone.

### Phase 1 — Write the Research Plan

Create `research-plan.md`. It is the contract for the whole investigation.

```markdown
# Research Plan: [Question]

## Objective
[One sentence: the decision or understanding this answers.]

## Hypotheses to test
- H1: [claim we suspect is true, and what would falsify it]
- H2: ...

## Sub-Questions (priority + dependencies)
1. [Critical] [gates others] — owner: <specialist>
2. [High] — owner: <specialist>
3. [Medium] — can run in parallel with 2
4. [Low] nice-to-have

## Team & ownership
- Surveyor: maps sources for Q1–Q3
- Domain specialist A: interprets Q1, Q2
- Methodologist: audits rigor of Q2 evidence
- Contrarian: challenges assumptions each loop

## Search strategy
- Per sub-question: 2–3 query variants (synonym / specificity ladder / source-type targeting)
- Source-quality bar: peer-reviewed > official report > reputable expert > news > blog
- Budget: aim for 10–20 searches per iteration; track count

## Convergence criteria (when are we "done"?)
- All sub-questions addressed
- Every load-bearing claim has 2+ independent sources
- Each contradiction either resolved or logged as unresolved
- Contrarian's open challenges answered or recorded
- Confidence meets target: [High/Medium] defined explicitly

## Assumptions to challenge
- A1: [thing the team currently takes for granted]
- A2: ...
```

### Phase 2 — Dispatch Investigation (layers)

Run the DAG from Phase 1, a layer at a time. For each specialist, require a tight,
comparable report so integration is fast:

```
ROLE: <specialty>
FINDINGS: <what the sources actually say>
EVIDENCE: <key claims with citations — [n] referencing source-log>
CONFIDENCE: <High/Medium/Low — and why>
ASSUMPTIONS CHALLENGED: <which of A1..An this weakens or supports>
OPEN QUESTIONS: <what's still unknown or contradictory>
INTERFACES: <what it needs from / hands to other specialists>
```

- **Roots first**: gating sub-questions, so dependents build on settled ground.
- **Fan-out in parallel**: independent specialists, each fed the shared context + root
  outputs.
- The **Surveyor** maps the landscape; **Domain specialists** interpret; the
  **Methodologist** audits rigor; the **Contrarian** files dissent.

Per-search process (applied by every specialist): extract key claims with attribution,
note source type and publication date, flag contradictions with existing findings. Track
in `source-log.md`:

```markdown
## [Source N: Title]
- URL: [link]
- Type: [Academic/News/Official/Expert/Blog]
- Date: [publication date]
- Credibility: [High/Medium/Low]
- Key claims:
  - "[claim]" 
- Contradicts: [other source if applicable]
```

### Phase 3 — Challenge Assumptions (the loop's core)

This is what makes it a team, not a pile of consultants.

1. Route each specialist's output **along the seams** to interdependent specialists and
   to the **Contrarian**: "Here's what the domain specialist concluded on Q2. As
   Methodologist, where does the evidence not actually support that claim? As Contrarian,
   what assumption is doing the heavy lifting, and what disconfirming evidence exists?"
2. Carry the critique the way the runtime supports: spawn a fresh agent with both its
   prior output and the peer's, and tell it to *react from its stance* — defend or revise,
   don't re-answer blandly. (If the runtime can continue an agent in place, that's fine.)
3. The Contrarian must produce, each loop:
   - Hidden assumptions the team treats as ground truth
   - Disconfirming evidence and alternative explanations
   - Where confidence is overstated
4. **Every iteration must yield at least one** of: a falsified assumption, a resolved
   contradiction, a sharpened claim, or a new sub-question. If a loop changes nothing,
   stop or pivot — do not spin.

### Phase 4 — Update the Progress Log

Append to `research-progress.md` after every iteration:

```markdown
## Iteration [N] — [date/time]

### What changed since last loop
- [finding added / claim sharpened / assumption falsified]

### Confidence deltas
- Claim X: Low → Medium (corroborated by [n])
- Claim Y: unchanged (still single source)

### Contradictions
- Open: [list] — resolution attempt: [query dispatched]
- Closed: [list] — how resolved

### Assumptions challenged
- A1: weakened by [evidence] — team now treats as [revised stance]

### Decision
- [Continue deeper on Q2] / [Pivot to Q4] / [Converge — criteria met]
```

### Phase 5 — Convergence Check

Before synthesizing, verify against the plan's convergence criteria:

| Condition                              | Action                                  |
| -------------------------------------- | --------------------------------------- |
| Sub-question unanswered                | Next iteration, targeted specialist     |
| Load-bearing claim has single source   | Search for corroboration               |
| Major contradiction unresolved         | Search for resolution/context           |
| Contrarian challenge unaddressed       | Force a response or log as open risk    |
| Convergence criteria met               | Proceed to synthesis                    |
| Iteration budget exhausted             | Note limitations, proceed              |

Recursive verification for high-stakes claims — don't trust a claim one hop from source:

```
Level 1: Source says X
Level 2: Source cites study Y → verify Y exists and says X
Level 3: Study methodology → is it rigorous? (Methodologist)
Status: [Confirmed/Partially Confirmed/Unverified/Contradicted]
```

### Phase 6 — Synthesize the Report

Write `research-report.md`. Lead with conclusions, support with evidence, cite everything.

```markdown
# [Research Question]

## Executive Summary
[2–3 sentence answer with confidence level]

## Key Findings
### Finding 1: [Statement]
[Evidence synthesis with citations]
- Source A reports... [1]
- Corroborated by... [2]
- However, Source C notes... [3]

## Analysis
[Interpretation connecting findings]

## Where the team disagreed and how I ruled
[The live tensions and your reasoning — the most valuable part]

## Assumptions challenged
[Which initial assumptions were falsified/revised and what changed]

## Limitations & Gaps
- [What couldn't be verified]
- [Areas needing more research]
- [Potential biases in available sources]

## Confidence Assessment
| Claim   | Confidence | Basis                    |
| ------- | ---------- | ------------------------ |
| Claim 1 | High       | 3+ independent sources   |
| Claim 2 | Medium     | 2 sources, some conflict |

## Sources
[Required — every source used, in citation order]
[1] Author/Publisher, "Title", Publication/Site, Date. URL
[2] ...
```

## Anti-Patterns to Avoid

- ❌ **Lone generalist** — answering without spawning the specialist team.
- ❌ **Echo chamber** — team agrees too easily; no real contrarian challenge.
- ❌ **One round then done** — stopping before the deepening loop.
- ❌ **Confidence without 2+ independent sources** for load-bearing claims.
- ❌ **Invisible assumptions** — treating untested premises as ground truth.
- ❌ **No progress log** — state lives only in your context, not in a file.
- ❌ **Omitting the sources list** — the report must show every source used.
- ❌ **Stale experts** — specialists reciting memory instead of searching current sources.

## Quality Checklist

Before delivering the final report:

- [ ] Team composed and dispatched in layers
- [ ] `research-plan.md` written with convergence criteria
- [ ] At least one assumption-challenge loop completed
- [ ] All sub-questions addressed
- [ ] Every load-bearing claim has 2+ independent sources
- [ ] Contradictions acknowledged (resolved or logged)
- [ ] Confidence levels stated
- [ ] Limitations documented
- [ ] Sources diverse, credible, and recent where required
- [ ] `research-progress.md` updated each iteration
- [ ] `research-report.md` has a visible Sources section listing every source

## Query Decomposition Playbook

Techniques for breaking a complex question into searchable sub-questions and queries.

### Decomposition frameworks

- **Hierarchical** — break into levels of abstraction (domains → specifics).
  ```
  Level 0: "Best programming language for AI in 2025?"
  Level 1: Performance · Ecosystem · Learning curve · Adoption
  Level 2: Benchmarks · Library availability · Community size · ...
  ```
- **Multi-hop** — chain reasoning across hops (cause → mechanism → effect → measurement).
  ```
  "How did the 2024 chip shortage affect EV prices?"
  Hop 1: cause of shortage → Hop 2: chips used in EVs → Hop 3: % of EV cost
  → Hop 4: manufacturer response → Hop 5: actual 2024 price change
  ```
- **Comparative** — for "which is better", decompose by dimension (scalability, complexity,
  features, adoption, support, performance).
- **Temporal** — for questions spanning time, decompose by period (pre / during / after / future).
- **Stakeholder** — for contested questions, decompose by perspective (artists, developers,
  legal, consumers, platforms).

### Query reformulation

| Technique            | Example                                                          |
| -------------------- | --------------------------------------------------------------- |
| Synonym expansion    | "AI" → "machine learning", "deep learning"                     |
| Specificity ladder   | "AI healthcare" → "radiology AI FDA approved 2024"             |
| Source targeting     | append "peer reviewed" / "government report" / "meta-analysis" |
| Negation queries     | also search the opposing view ("remote work disadvantages")    |

### Dependency mapping

Classify sub-questions: **Prerequisite** (A before B), **Parallel** (independent),
**Refinement** (B narrows A), **Validation** (B checks A). Map before searching so layers
run in the right order.

### Search batching

```markdown
## Batch 1 (Foundation) — parallel
- Q1 context · Q2 current state · Q3 major players
## Batch 2 (Deep dive) — after Batch 1
- Q4 specific aspect from Q1 · Q5 follow-up on surprising Q2 result
## Batch 3 (Verification) — after Batch 2
- Q6 verify key claim · Q7 search for contradicting evidence
```

### Common mistakes

| Mistake               | Fix                                  |
| --------------------- | ------------------------------------ |
| Too many sub-questions | Limit to 5–7, prioritize           |
| Overlapping queries   | De-duplicate before searching        |
| Missing negation      | Always add opposing-view queries     |
| No dependency mapping | Map the DAG before searching         |

## Verification Playbook

Systematic claim verification. Drives Phase 3 (challenge) and Phase 5 (convergence).

### IRVL loop

```
DECISION ("enough evidence? what gaps?")
   → RETRIEVAL (refined queries on gaps)
   → VERIFICATION (score confidence, check source quality)
   → TERMINATION CHECK (threshold met OR budget out?)
        No → loop back · Yes → synthesize
```

### Source credibility

Score each source on Authority / Recency / Evidence / Bias / Corroboration (High=3 … Low=1).

- 12–15: High · 8–11: Medium · 5–7: Low (caution) · <5: exclude or flag.

Tier hierarchy (highest → lowest trust):
1. Peer-reviewed papers, government statistics, meta-analyses, primary docs
2. Industry reports (disclosed method), reputable multi-sourced news, credentialed experts
3. Trade press, conference talks, preprints, well-sourced journalism
4. Opinion pieces, expert blogs, press releases, social media (verify independently)
5. Anonymous, known-misinformation, stale, undisclosed-conflict (exclude/flag)

### Claim verification patterns

- **Triangulation** — confirm via 3+ independent sources; record result
  (Confirmed / Partial / Contradicted).
- **Citation chain** — trace "X per study Y" back to Y; verify Y says X, then check
  Y's methodology. Status: Verified / Broken at level N / Misrepresented.
- **Contradiction resolution** — when sources disagree, check: same thing measured? same
  period? same method? same definitions? one more credible? Then rule A / B / both-partial
  / unresolvable (present both).
- **Recency** — for volatile topics, check whether newer sources exist and whether the
  claim needs a recency qualifier.

### Confidence scoring (per claim)

| Level       | Criteria                                         | Report as              |
| ----------- | ------------------------------------------------ | ---------------------- |
| Very High   | 3+ Tier-1, no contradictions, recent            | Established fact       |
| High        | 2+ reliable, minor contradictions resolved      | State with confidence  |
| Medium      | 1–2 sources or unresolved minor contradictions  | State with caveat      |
| Low         | Single source or major contradictions           | Flag uncertainty       |
| Very Low    | Weak source or strong contradictions            | Consider excluding     |

### Iteration triggers / stop conditions

| Search again when…              | Stop when…                              |
| ------------------------------- | --------------------------------------- |
| Sub-question unanswered         | Confidence target met for all claims    |
| Key claim has single source     | Search budget exhausted                 |
| All sources same perspective    | Diminishing returns (same results)      |
| Claim contradicted              | Topic has limited available info        |
| Source credibility low          |                                         |

### Common mistakes

Confirmation bias (search opposites too) · authority fallacy (verify independently) ·
recency bias (balance with quality) · false balance (weight by credibility) ·
citation laundering (trace to original source).

## Additional Resources

- For the generic team-orchestration mechanics, see the `assemble-a-team` skill
