---
name: deep-research
description: Conduct comprehensive multi-source research for complex questions. Use when the user asks a complicated question requiring multiple sources, in-depth analysis, cross-referencing, or expert-level research reports. Triggers on "research", "investigate", "deep dive", "analyze thoroughly", "comprehensive report", or questions involving conflicting sources.
---

# Deep Research

Autonomous research agent for complex, multi-source questions requiring synthesis, verification, and expert-level analysis.

## When to Activate

- Complex questions requiring multiple sources
- Topics with conflicting or nuanced information
- Requests for comprehensive analysis or reports
- Questions requiring cross-domain expertise
- Fact-checking with source verification

## Time Awareness

**Respect the user's time frame when given.** If none is given, use the **most recent** information on the topic.

1. **User specifies a time frame** → Restrict sources and claims to that period.
   - Examples: "this year", "2024", "last 5 years", "recent studies", "current state"
   - In queries: add date/year constraints; in synthesis, note when evidence is from.
2. **No time frame given** → Prefer **most recent** evidence.
   - For facts and trends: prioritize recent sources (e.g. last 2–3 years unless topic is historical).
   - For "current state" or "what is X now": emphasize latest data and reports.
   - For historical or "since when" questions: use the period the user asked about.
3. **Always record publication date** in the source log and mention recency in the report when it matters (e.g. "As of 2024..." or "Based on 2023 data...").

## Research Pipeline

Execute these phases sequentially. Each phase builds on the previous.

```
┌─────────────────────────────────────────────────────────────────┐
│  1. DECOMPOSE → 2. PLAN → 3. SEARCH → 4. VERIFY → 5. SYNTHESIZE │
│       ↑                                    │                    │
│       └────────── ITERATE IF GAPS ─────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Query Decomposition

Break the complex question into atomic sub-questions.

### Decomposition Strategy

1. **Identify question type**:
   - Factual (who, what, when, where)
   - Causal (why, how)
   - Comparative (which is better, differences)
   - Predictive (what will happen)
   - Evaluative (should, is it good)

2. **Extract entities and relationships**:
   - Key concepts, actors, events
   - Temporal constraints (dates, periods)
   - Scope constraints (geographic, domain)

3. **Generate sub-questions** (aim for 3-7):
   ```
   Original: "How will AI impact healthcare costs in the next decade?"
   
   Sub-questions:
   1. What are current AI applications in healthcare?
   2. What cost savings have been documented from existing AI healthcare tools?
   3. What are projected AI adoption rates in healthcare?
   4. What are the main cost drivers in healthcare that AI could affect?
   5. What barriers exist to AI adoption in healthcare?
   6. What do expert forecasts predict for AI healthcare costs?
   ```

4. **Identify dependencies**:
   - Which questions must be answered first?
   - Which can be searched in parallel?

### Reformulation Techniques

For each sub-question, generate 2-3 search query variants:

| Technique              | Example                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| **Synonym expansion**  | "AI healthcare" → "artificial intelligence medicine", "ML clinical" |
| **Specificity ladder** | Broad: "AI costs" → Specific: "radiology AI ROI 2024 study"         |
| **Source targeting**   | Add: "research paper", "meta-analysis", "government report"         |
| **Recency filter**     | Add year constraints for time-sensitive topics                      |

---

## Phase 2: Research Planning

Create a structured research plan before searching.

### Plan Template

```markdown
## Research Plan: [Original Question]

### Objective
[One sentence goal]

### Sub-Questions (Priority Order)
1. [Critical] Question that unlocks others
2. [High] Core factual questions
3. [Medium] Supporting context
4. [Low] Nice-to-have details

### Search Strategy
- Parallel batch 1: [Q1, Q2] (independent)
- Sequential: Q3 depends on Q1 results
- Parallel batch 2: [Q4, Q5]

### Source Requirements
- [ ] Academic sources (peer-reviewed)
- [ ] Official reports (government, organizations)
- [ ] Expert commentary (reputable analysts)
- [ ] Recent news (within 12 months)
- [ ] **Time frame**: User-specified (e.g. 2024, last 5 years) or default to most recent

### Confidence Target
[High/Medium] - Define what "good enough" means
```

---

## Phase 3: Parallel Search Execution

Execute searches efficiently using parallel batches.

### Search Execution Rules

1. **Batch independent queries**: Run 3-5 searches simultaneously
2. **Diverse source strategy**: Mix query variants to avoid echo chambers
3. **Budget awareness**: Track search count, aim for 10-20 total searches

### Per-Search Process

For each search result:

1. **Extract key claims** with source attribution
2. **Note source type** (academic, news, blog, official)
3. **Record publication date**
4. **Flag contradictions** with existing findings

### Source Tracking Format

```markdown
## Source Log

### [Source 1: Title]
- URL: [link]
- Type: [Academic/News/Official/Expert/Blog]
- Date: [publication date]
- Credibility: [High/Medium/Low]
- Key claims:
  - Claim 1: "[quote or paraphrase]"
  - Claim 2: "[quote or paraphrase]"
- Contradicts: [other source if applicable]
```

---

## Phase 4: Iterative Verification Loop

**Critical phase** - Do not skip. Verify before synthesizing.

### Verification Protocol

```
┌─────────────────────────────────────────┐
│  For each major claim:                  │
│  1. Is it supported by 2+ sources?      │
│  2. Do sources have different biases?   │
│  3. Is the claim recent enough?         │
│  4. Are there credible contradictions?  │
└─────────────────────────────────────────┘
```

### Self-Reflection Questions

After initial search round, explicitly answer:

1. **Coverage check**: "Have I addressed all sub-questions?"
2. **Confidence check**: "Which claims have weak evidence?"
3. **Bias check**: "Are my sources ideologically diverse?"
4. **Gap check**: "What's missing that would change conclusions?"
5. **Contradiction check**: "Have I investigated conflicting claims?"

### Iteration Decision

| Condition                 | Action                           |
| ------------------------- | -------------------------------- |
| Sub-question unanswered   | Search with reformulated queries |
| Claim has single source   | Search for corroboration         |
| Major contradiction found | Search for resolution/context    |
| Confidence target met     | Proceed to synthesis             |
| Search budget exhausted   | Note limitations, proceed        |

### Recursive Verification

For high-stakes claims:

```markdown
## Verification Chain: [Claim]

Level 1: Original source says X
Level 2: Source cites study Y → Verify study Y exists and says X
Level 3: Study methodology → Is it rigorous?

Verification status: [Confirmed/Partially Confirmed/Unverified/Contradicted]
```

---

## Phase 5: Synthesis & Report Generation

Combine findings into a coherent, well-cited report.

### Synthesis Rules

1. **Lead with conclusions**, support with evidence
2. **Cite every factual claim** with source reference
3. **Acknowledge uncertainty** explicitly
4. **Present contradictions** fairly, explain which view is better supported
5. **Separate facts from interpretation**

### Report Structure

**Always end the report with a visible "Sources" or "References" section** listing every source used. Readers must be able to see and verify where information came from.

```markdown
# [Research Question]

## Executive Summary
[2-3 sentence answer with confidence level]

## Key Findings

### Finding 1: [Statement]
[Evidence synthesis with citations]
- Source A reports... [1]
- This is corroborated by... [2]
- However, Source C notes... [3]

### Finding 2: [Statement]
[Evidence synthesis with citations]

## Analysis
[Your interpretation connecting the findings]

## Limitations & Gaps
- [What couldn't be verified]
- [Areas needing more research]
- [Potential biases in available sources]

## Confidence Assessment

| Claim   | Confidence | Basis                    |
| ------- | ---------- | ------------------------ |
| Claim 1 | High       | 3+ independent sources   |
| Claim 2 | Medium     | 2 sources, some conflict |
| Claim 3 | Low        | Single source, recent    |

## Sources
[Required — list every source used so readers can verify and follow up.]

[1] Author or Publisher, "Title", Publication/Site, Date. URL
[2] Author or Publisher, "Title", Publication/Site, Date. URL
[3] ...
```

### Showing Sources Used

- **Include a "Sources" (or "References") section** at the end of every deep-research report.
- **List every source** that was used to support findings, in citation order [1], [2] including, ...
- **Format each entry** so it can be used to find the source: author/publisher, title, publication/site, date, and URL.
- **Do not omit sources** or summarize them away; the full list must be visible in the delivered report.

---

## Chain-of-Thought Template

Use this internal reasoning structure:

```markdown
**Thinking through [question]...**

1. Decomposition: I need to understand [X] before I can answer [Y]
2. Current knowledge: I found that [claims] from [sources]
3. Gaps identified: I still don't know [Z]
4. Contradictions: Source A says X, but Source B says Y
5. Resolution strategy: I'll search for [specific query] to resolve
6. Confidence update: After verification, I'm [%] confident because [reason]
```

---

## Anti-Patterns to Avoid

- ❌ Single-source conclusions for complex topics
- ❌ Ignoring contradictory evidence
- ❌ Treating all sources as equally credible
- ❌ Stopping after first search round without verification
- ❌ Presenting uncertain claims as facts
- ❌ Forgetting to cite sources
- ❌ Echo chamber sourcing (all sources same perspective)
- ❌ Omitting or hiding the sources list (report must show all sources used)

## Quality Checklist

Before delivering final report:

- [ ] All sub-questions addressed
- [ ] Every claim has citation
- [ ] Contradictions acknowledged
- [ ] Confidence levels stated
- [ ] Limitations documented
- [ ] Sources are diverse and credible
- [ ] Recency appropriate for topic
- [ ] **Sources used are shown**: a "Sources" or "References" section lists every source with title, publication, date, and URL

## Additional Resources

- For query decomposition strategies, see [references/query-decomposition.md](references/query-decomposition.md)
- For verification patterns, see [references/verification-patterns.md](references/verification-patterns.md)
