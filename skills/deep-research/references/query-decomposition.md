# Query Decomposition Strategies

Advanced techniques for breaking complex questions into searchable sub-queries.

## Decomposition Frameworks

### 1. Hierarchical Decomposition

Break questions into levels of abstraction.

```
Level 0 (Original): "What's the best programming language for AI in 2025?"

Level 1 (Domains):
├── Performance considerations
├── Ecosystem maturity
├── Learning curve
└── Industry adoption

Level 2 (Specifics):
├── Performance
│   ├── Benchmark comparisons
│   ├── Memory efficiency
│   └── Parallel processing support
├── Ecosystem
│   ├── Available libraries
│   ├── Framework support
│   └── Community size
...
```

### 2. Multi-Hop Decomposition

For questions requiring chained reasoning.

```
Original: "How did the 2024 chip shortage affect EV prices?"

Hop 1: What caused the 2024 chip shortage?
Hop 2: Which chips are used in EVs?
Hop 3: What % of EV cost is chips?
Hop 4: How did EV manufacturers respond to shortage?
Hop 5: What were actual EV price changes in 2024?
```

### 3. Comparative Decomposition

For "which is better" or "what's the difference" questions.

```
Original: "Kubernetes vs Docker Swarm for production?"

Dimension questions:
- Scalability: How do they scale? Limits?
- Complexity: Setup and maintenance effort?
- Features: What can each do that the other can't?
- Adoption: Industry usage statistics?
- Support: Commercial support options?
- Performance: Benchmark comparisons?
```

### 4. Temporal Decomposition

For questions spanning time periods.

```
Original: "How has remote work evolved since COVID?"

Timeline questions:
- Pre-2020: What was remote work adoption before COVID?
- 2020-2021: How did pandemic change remote work?
- 2022-2023: What return-to-office trends emerged?
- 2024-2025: Current state and trends?
- Future: Expert predictions?
```

### 5. Stakeholder Decomposition

For questions with multiple perspectives.

```
Original: "Is AI art ethical?"

Stakeholder questions:
- Artists: How do human artists view AI art?
- AI developers: What ethical guidelines exist?
- Legal: Copyright and ownership issues?
- Consumers: Market demand and perception?
- Platforms: Policy responses from art platforms?
```

## Query Reformulation Techniques

### Synonym Expansion Matrix

| Original Term | Synonyms/Variants |
|---------------|-------------------|
| AI | artificial intelligence, machine learning, ML, deep learning |
| impact | effect, influence, consequences, implications |
| cost | price, expense, spending, investment, ROI |
| research | study, analysis, investigation, paper, report |
| best | top, leading, recommended, optimal |

### Specificity Ladder

Start broad, then narrow based on results.

```
Level 1 (Broad): "AI healthcare"
Level 2 (Medium): "AI diagnostic tools hospitals"
Level 3 (Specific): "radiology AI FDA approved 2024"
Level 4 (Precise): "Viz.ai stroke detection clinical outcomes"
```

### Source-Targeted Queries

Append source type to improve result quality:

| Source Type | Query Suffix |
|-------------|--------------|
| Academic | "peer reviewed", "journal article", "research paper" |
| Official | "government report", "white paper", "official statistics" |
| Expert | "expert analysis", "industry report", "analyst opinion" |
| Data | "statistics", "data", "survey results", "meta-analysis" |
| Recent | "[year]", "latest", "recent study" |

### Negation Queries

Search for opposing views explicitly:

```
Original: "Benefits of remote work"
Negation: "Remote work disadvantages", "Return to office arguments"
```

## Dependency Mapping

Identify which sub-questions depend on others.

### Dependency Types

1. **Prerequisite**: Must answer A before B makes sense
2. **Parallel**: A and B are independent
3. **Refinement**: B is a more specific version of A
4. **Validation**: B verifies claims from A

### Example Dependency Graph

```
Q1: What is X? [Foundation]
    ↓
Q2: How does X work? [Depends on Q1]
    ↓
Q3: What are X's limitations? [Depends on Q2]

Q4: What alternatives to X exist? [Parallel to Q2]
    ↓
Q5: How do alternatives compare? [Depends on Q2, Q4]
```

## Search Batching Strategy

### Batch Planning Template

```markdown
## Batch 1 (Foundation) - Run in parallel
- Q1: [Basic definition/context]
- Q2: [Current state/statistics]
- Q3: [Major players/examples]

## Batch 2 (Deep dive) - After Batch 1
- Q4: [Specific aspect from Q1 findings]
- Q5: [Follow-up on surprising Q2 result]

## Batch 3 (Verification) - After Batch 2
- Q6: [Verify key claim from Batch 2]
- Q7: [Search for contradicting evidence]
```

## Common Decomposition Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| Too many sub-questions | Scope creep, budget exhaustion | Limit to 5-7, prioritize |
| Too few sub-questions | Shallow coverage | Use framework above |
| Overlapping queries | Redundant results | Check for duplication |
| Missing negation | One-sided evidence | Add opposing view queries |
| No dependency mapping | Inefficient ordering | Map before searching |
