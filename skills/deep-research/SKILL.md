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

| Technique              | Example                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| **Synonym expansion**  | "renewable energy" → "solar wind power", "clean energy generation"          |
| **Specificity ladder** | Broad: "diet benefits" → Specific: "Mediterranean diet cardiovascular 2023" |
| **Source targeting**   | Add: "research paper", "meta-analysis", "government report"                 |
| **Recency filter**     | Add year constraints for time-sensitive topics                              |

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

## Memory & Persistence System

Track research progress in a structured file to maintain context across sessions and enable deeper analysis.

### Memory File Format

```yaml
# research-memory-[timestamp].yaml
research:
  id: "deep-research-2024-01-15-143022"
  question: "How will AI impact healthcare costs in the next decade?"
  started_at: "2024-01-15T14:30:22Z"
  status: "in_progress"  # planning|researching|synthesizing|completed
  user_constraints:
    depth: "comprehensive"
    time_frame: "next decade"
    expected_output: "detailed report with sources"
    special_requirements: ["PDF analysis", "academic papers"]

  phases:
    planning:
      completed: true
      timestamp: "2024-01-15T14:30:45Z"
      user_responses:
        research_approach: "multi-source with academic focus"
        key_areas: ["cost savings", "adoption barriers", "expert predictions"]
        depth_preference: "in-depth with primary sources"

    decomposition:
      completed: true
      sub_questions:
        - id: "current_ai_healthcare"
          question: "What are current AI applications in healthcare?"
          status: "completed"
          priority: "high"
        - id: "cost_savings_evidence"
          question: "What cost savings have been documented?"
          status: "in_progress"
          priority: "high"

    research:
      current_batch: 2
      batches:
        batch_1:
          status: "completed"
          queries: ["AI healthcare applications 2024", "machine learning medical diagnosis"]
          sources_found: 12
        batch_2:
          status: "in_progress"
          queries: ["AI healthcare cost savings studies", "ROI AI medical tools"]
          sources_found: 8

  findings:
    key_claims:
      - id: "ai_diagnostic_accuracy"
        claim: "AI improves diagnostic accuracy by 10-30%"
        confidence: "high"
        sources: ["source_1", "source_2", "source_3"]
        verification_status: "triangulated"
        last_updated: "2024-01-15T15:15:30Z"

    contradictions:
      - id: "cost_savings_timeline"
        claim_a: "Immediate cost savings possible"
        claim_b: "Cost savings take 2-3 years"
        resolution_strategy: "investigate further"
        sources: ["academic_paper_2023", "industry_report_2024"]

    gaps:
      - question: "Long-term cost implications beyond 5 years"
        reason: "Limited longitudinal studies"
        mitigation: "Search for expert predictions and models"

  sources:
    source_1:
      title: "AI in Medical Imaging: A Systematic Review"
      type: "academic"
      url: "https://example.com/paper1.pdf"
      date: "2024-01-10"
      credibility_score: 14
      key_claims: ["claim_1", "claim_2"]

  checkpoints:
    - id: "mid_research_review"
      timestamp: "2024-01-15T15:45:00Z"
      findings_so_far: "Found 15 sources, 3 major themes emerging"
      user_feedback: "Direction looks good, focus more on economic analysis"
      adjustments_made: ["Added economic queries", "Prioritized ROI studies"]

  synthesis:
    status: "pending"
    outline:
      executive_summary: "AI will reduce healthcare costs by 5-15% within 5 years"
      key_findings:
        - "Diagnostic improvements"
        - "Administrative efficiency"
      limitations:
        - "Implementation challenges"
        - "Regulatory hurdles"
```

### Memory Management Rules

1. **Create memory file** at research start with timestamp
2. **Update incrementally** after each major phase or finding
3. **Persist across sessions** - allow resuming interrupted research
4. **Track user interactions** - store feedback and corrections
5. **Enable sharing** - memory files can be exported/shared for collaboration

### Memory-Driven Research Flow

```
START: User Question
       ↓
┌─────────────────┐
│   INITIALIZE    │ ← Create research memory file
│    MEMORY       │
└─────────────────┘
       ↓
┌─────────────────┐
│   PLANNING      │ ← Ask user clarifying questions
│  QUESTIONS      │   about depth, format, focus areas
└─────────────────┘
       ↓
┌─────────────────┐
│ DECOMPOSITION   │ ← Break question into sub-questions
└─────────────────┘
       ↓
┌─────────────────┐     ┌─────────────────┐
│   BATCHED       │ --> │   PDF/DOC       │
│   SEARCH        │     │   ANALYSIS      │
└─────────────────┘     └─────────────────┘
       ↓                           ↓
┌─────────────────┐     ┌─────────────────┐
│  FINDINGS       │ <-- │   EXTRACTED     │
│ EXTRACTION      │     │   CLAIMS &      │
└─────────────────┘     │   INSIGHTS      │
                        └─────────────────┘
       ↓
┌─────────────────┐
│  CHECKPOINT     │ ← Pause for user feedback
│  & FEEDBACK     │   "Is this going right direction?"
└─────────────────┘
       ↓
       ├─ Continue ──→ [Adjust search strategy]
       │
       ├─ Pivot ─────→ [Add/remove focus areas]
       │
       └─ Deepen ────→ [More detailed analysis]

┌─────────────────┐
│ VERIFICATION    │ ← Cross-reference claims, check contradictions
└─────────────────┘
       ↓
┌─────────────────┐
│   SYNTHESIS     │ ← Build comprehensive report
│   & REPORT      │
└─────────────────┘
       ↓
┌─────────────────┐
│   FINAL         │ ← Present to user
│   DELIVERY      │
└─────────────────┘
       ↓
┌─────────────────┐
│  MEMORY         │ ← Archive for future reference
│  ARCHIVAL       │
└─────────────────┘
```

## Interactive Questioning Phase

### Pre-Research Questions

Before starting research, ask the user clarifying questions:

```markdown
## Research Planning Questions

**1. Research Depth & Scope**
What level of depth are you looking for?
- [ ] Overview/summary (quick answers)
- [ ] Detailed analysis (comprehensive coverage)
- [ ] Expert-level (academic papers, technical details)

**2. Expected Output Format**
What format would be most useful?
- [ ] Executive summary with key findings
- [ ] Detailed report with evidence and citations
- [ ] Comparative analysis
- [ ] Prediction/forecast based on current trends

**3. Key Focus Areas**
Which aspects are most important to you? (Select all that apply)
- [ ] Current state/trends
- [ ] Future predictions
- [ ] Specific technologies/regions
- [ ] Cost/benefit analysis
- [ ] Implementation challenges

**4. Source Preferences**
Any preferred source types?
- [ ] Academic/research papers
- [ ] Industry reports
- [ ] News/media coverage
- [ ] Government data
- [ ] Expert opinions

**5. Time Sensitivity**
How important is recency?
- [ ] Very important (focus on latest data)
- [ ] Somewhat important (balance with quality)
- [ ] Not important (prioritize comprehensive historical view)
```

### Mid-Research Checkpoints

Stop research periodically to validate direction:

```markdown
## Research Checkpoint - Batch [N] Complete

**Findings so far:**
- [Key finding 1]
- [Key finding 2]
- [Emerging pattern/trend]

**Direction Check:**
Are we exploring the right areas? Should we:
- [ ] Continue current direction
- [ ] Pivot to different focus areas
- [ ] Add specific topics to investigate
- [ ] Reduce scope on certain areas

**Depth Adjustment:**
Current depth level seems [appropriate/too shallow/too deep]. Should we:
- [ ] Maintain current depth
- [ ] Go deeper on [specific topic]
- [ ] Summarize [specific topic] more briefly

**New Questions Emerged:**
- [Question that arose during research]
- [Additional clarification needed]
```

## Enhanced PDF & Document Analysis

### PDF Processing Capabilities

For comprehensive research, automatically download and analyze:

1. **Academic Papers**: Full-text extraction, citation analysis, methodology review
2. **Research Reports**: Executive summaries, data extraction, methodology assessment
3. **Technical Documentation**: API docs, implementation guides, specifications
4. **Government Reports**: Statistical data, policy analysis, regulatory frameworks

### PDF Analysis Pipeline

```
PDF Source → Download → Text Extraction → Content Analysis → Key Insights → Memory Storage
     ↓              ↓            ↓                ↓              ↓            ↓
  URL/Title     Local File    Structured Text   Claims/Facts   Summaries    Research Memory
```

### Document Intelligence Features

- **Citation Extraction**: Track references and build citation networks
- **Figure/Table Analysis**: Extract data from visualizations
- **Methodology Assessment**: Evaluate research rigor and validity
- **Cross-Reference Verification**: Link claims across multiple documents
- **Content Summarization**: Generate structured abstracts and key findings

## Updated Pipeline Structure

### Enhanced Research Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. QUESTION → 2. MEMORY INIT → 3. PLANNING QUESTIONS → 4. USER INPUT │
│                                                                     │
│  5. DECOMPOSITION → 6. MEMORY UPDATE → 7. BATCHED SEARCH → 8. PDF ANALYSIS │
│                                                                     │
│  9. VERIFICATION → 10. CHECKPOINT → 11. USER FEEDBACK → 12. ADJUSTMENTS │
│                                                                     │
│  13. ITERATION OR → 14. SYNTHESIS → 15. FINAL REPORT → 16. MEMORY ARCHIVE │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Enhancements

1. **Memory Integration**: All phases update persistent memory
2. **User Interaction**: Multiple checkpoints for feedback and course correction
3. **Document Intelligence**: Advanced PDF and paper analysis capabilities
4. **Iterative Refinement**: Research adapts based on findings and user input
5. **Comprehensive Tracking**: Full audit trail of research process and decisions

## Additional Resources

- For query decomposition strategies, see [references/query-decomposition.md](references/query-decomposition.md)
- For verification patterns, see [references/verification-patterns.md](references/verification-patterns.md)
