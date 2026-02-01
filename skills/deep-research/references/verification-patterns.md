# Verification Patterns for Deep Research

Systematic approaches to verify claims and ensure research integrity.

## Core Verification Framework

### The IRVL Pattern (Iterative Retrieval-Verification Loop)

```
┌─────────────────────────────────────────────────────────────┐
│                    DECISION/PLANNING                        │
│  "Do I have enough evidence? What gaps exist?"              │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      RETRIEVAL                              │
│  Execute refined queries targeting gaps                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   VERIFICATION                              │
│  Score confidence, check source quality, find support       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              TERMINATION CHECK                              │
│  Confidence threshold met OR budget exhausted?              │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              │ No                    │ Yes
              ▼                       ▼
         [Loop back]            [Proceed to synthesis]
```

## Self-Reflection Protocol

### After Each Search Round

Execute these reflection questions explicitly:

```markdown
## Reflection Round [N]

### Coverage Analysis
- Sub-questions answered: [list]
- Sub-questions remaining: [list]
- New questions emerged: [list]

### Evidence Quality
| Claim   | Sources | Source Quality | Confidence       |
| ------- | ------- | -------------- | ---------------- |
| Claim 1 | 3       | 2 High, 1 Med  | High             |
| Claim 2 | 1       | 1 Low          | Low - needs more |

### Bias Check
- Political lean of sources: [Left/Center/Right mix]
- Industry affiliation: [Any conflicts of interest?]
- Geographic diversity: [Single region or global?]

### Contradiction Log
| Claim A   | Source | Claim B    | Source | Resolution         |
| --------- | ------ | ---------- | ------ | ------------------ |
| X is true | [1]    | X is false | [2]    | Need more research |

### Decision
- [ ] Continue searching (gaps identified)
- [ ] Proceed to synthesis (confidence met)
- [ ] Note limitations and proceed (budget exhausted)
```

## Source Credibility Assessment

### Credibility Scoring Matrix

| Factor            | High (3)                                   | Medium (2)                      | Low (1)                     |
| ----------------- | ------------------------------------------ | ------------------------------- | --------------------------- |
| **Authority**     | Peer-reviewed, government, established org | Industry report, reputable news | Blog, social media, unknown |
| **Recency**       | Within 1 year                              | 1-3 years                       | 3+ years                    |
| **Evidence**      | Data-backed, citations                     | Some evidence                   | Opinion, anecdotal          |
| **Bias**          | Neutral, disclosed conflicts               | Some bias                       | Obvious agenda              |
| **Corroboration** | Multiple independent sources               | Some corroboration              | Single source               |

**Score interpretation:**
- 12-15: High credibility
- 8-11: Medium credibility
- 5-7: Low credibility (use with caution)
- <5: Unreliable (exclude or flag heavily)

### Source Type Hierarchy

```
Tier 1 (Highest trust):
├── Peer-reviewed academic papers
├── Government official statistics
├── Meta-analyses and systematic reviews
└── Primary source documents

Tier 2 (High trust):
├── Industry research reports (disclosed methodology)
├── Reputable news organizations (multiple sources cited)
├── Expert commentary (credentialed in field)
└── Official organizational statements

Tier 3 (Medium trust):
├── Trade publications
├── Conference presentations
├── Preprints (not yet peer-reviewed)
└── Well-sourced journalism

Tier 4 (Low trust - verify independently):
├── Opinion pieces
├── Blog posts (even from experts)
├── Press releases
└── Social media

Tier 5 (Exclude or flag):
├── Anonymous sources
├── Known misinformation outlets
├── Outdated sources (context-dependent)
└── Sources with undisclosed conflicts
```

## Claim Verification Patterns

### Pattern 1: Triangulation

Verify claims through 3+ independent sources.

```markdown
## Claim: "[Statement]"

Source 1: [Type: Academic]
- Says: "[exact quote or paraphrase]"
- Date: [when]

Source 2: [Type: News]
- Says: "[exact quote or paraphrase]"
- Date: [when]

Source 3: [Type: Official]
- Says: "[exact quote or paraphrase]"
- Date: [when]

Triangulation result: [Confirmed/Partial/Contradicted]
```

### Pattern 2: Citation Chain Verification

Trace claims back to original sources.

```markdown
## Claim Chain: "[Statement]"

Level 0: Article says "X according to study Y"
    ↓
Level 1: Find study Y → Does it actually say X?
    ↓
Level 2: Check study methodology → Is it rigorous?
    ↓
Level 3: Check study citations → What's the foundation?

Chain status: [Verified/Broken at Level N/Misrepresented]
```

### Pattern 3: Contradiction Resolution

When sources disagree, investigate systematically.

```markdown
## Contradiction: [Topic]

Claim A: "[Statement]" - Source: [X]
Claim B: "[Opposite]" - Source: [Y]

Investigation:
1. Are they measuring the same thing? [Yes/No]
2. Different time periods? [Yes/No]  
3. Different methodologies? [Yes/No]
4. Different definitions? [Yes/No]
5. One source more credible? [Analysis]

Resolution:
- [ ] A is correct because [reason]
- [ ] B is correct because [reason]
- [ ] Both partially correct: [nuanced view]
- [ ] Unresolvable: [present both views]
```

### Pattern 4: Recency Verification

For time-sensitive claims.

```markdown
## Recency Check: "[Claim]"

Claim date: [when stated]
Current date: [now]
Topic volatility: [High/Medium/Low]

Questions:
1. Has significant change occurred since claim? [Yes/No]
2. Are newer sources available? [Yes/No]
3. Is the claim about a stable or changing phenomenon? [Stable/Changing]

Decision:
- [ ] Claim still valid
- [ ] Claim outdated - search for updates
- [ ] Claim needs recency qualifier in report
```

## Confidence Scoring

### Per-Claim Confidence

| Level         | Criteria                                           | Action                    |
| ------------- | -------------------------------------------------- | ------------------------- |
| **Very High** | 3+ Tier 1 sources, no contradictions, recent       | State as established fact |
| **High**      | 2+ reliable sources, minor contradictions resolved | State with confidence     |
| **Medium**    | 1-2 sources, or unresolved minor contradictions    | State with caveat         |
| **Low**       | Single source, or major contradictions             | Flag uncertainty          |
| **Very Low**  | Weak source, or strong contradictions              | Consider excluding        |

### Overall Research Confidence

```markdown
## Confidence Summary

Claims breakdown:
- Very High confidence: [N] claims
- High confidence: [N] claims
- Medium confidence: [N] claims
- Low confidence: [N] claims

Overall assessment: [High/Medium/Low]

Limiting factors:
- [Limited source availability]
- [Topic too recent for academic coverage]
- [Significant expert disagreement]
```

## Iteration Triggers

### When to Search Again

| Signal                       | Response                                |
| ---------------------------- | --------------------------------------- |
| Sub-question unanswered      | Reformulate query, try different angles |
| Single source for key claim  | Search for corroboration                |
| All sources same perspective | Search opposing viewpoint               |
| Claim contradicted           | Search for resolution/context           |
| Source credibility low       | Search for higher-tier sources          |
| Information outdated         | Search with recency filters             |

### When to Stop

| Signal                               | Action                        |
| ------------------------------------ | ----------------------------- |
| Confidence target met for all claims | Proceed to synthesis          |
| Search budget exhausted              | Document limitations, proceed |
| Diminishing returns (same results)   | Accept current state          |
| Topic has limited available info     | Note gap, proceed             |

## Common Verification Mistakes

| Mistake             | Problem                                 | Fix                                  |
| ------------------- | --------------------------------------- | ------------------------------------ |
| Confirmation bias   | Only finding supporting evidence        | Explicitly search for contradictions |
| Authority fallacy   | Trusting source without checking        | Verify claims independently          |
| Recency bias        | Preferring new over accurate            | Balance recency with source quality  |
| False balance       | Giving equal weight to unequal evidence | Weight by source credibility         |
| Citation laundering | Accepting circular citations            | Trace to original source             |
