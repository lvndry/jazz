---
name: startup-brainstorm
description: Brainstorm startup ideas using top-founder mental models, trend analysis, and competition research. Use when the user wants to brainstorm startup ideas, explore business opportunities, validate concepts, or think like elite founders. Triggers on "startup ideas", "business ideas", "what should I build", "startup brainstorm", "idea validation", "trends and opportunities", "think like a founder".
---

# Startup Brainstorm

Generate and evaluate startup ideas using the mental models of top founders (Thiel, Graham, Andreessen, Bezos, etc.), validated against current trends and competition.

## When to Use

- User wants to brainstorm startup ideas (general or in a domain)
- User asks "what should I build?", "business ideas", or "startup opportunities"
- User wants idea validation with trend and competition analysis
- User wants to think like elite founders when evaluating concepts

## Research Requirement

**Before generating or evaluating ideas**, use web search to:

- **Trends**: Macro, tech, regulatory, societal trends (use recency constraints: last 12–24 months)
- **Competition**: Direct competitors, adjacent players, substitutes
- **Market signals**: Funding rounds, acquisitions, analyst reports, "why now" factors

Cite sources and dates. Never invent market data.

## Workflow

```
1. CLARIFY → 2. TRENDS → 3. BRAINSTORM → 4. COMPETITION → 5. EVALUATE → 6. PRESENT
```

### Step 1: Clarify

- **Domain/vertical**: Industry, sector, or "anything"
- **Constraints**: B2B/B2C, geography, technical depth, team skills
- **User's edge**: Domain expertise, network, unfair advantage
- **Preferred output**: Single strong idea, list of 3–5, or full analysis of one concept

### Step 2: Trends (Search)

Search for:

- Macro: Regulation, policy, economics, labor, demographics
- Tech: AI/ML, infra, dev tools, hardware breakthroughs
- Societal: Remote work, health, climate, privacy, creator economy
- "Why now": What changed in last 2–3 years that enables this?

### Step 3: Brainstorm

Apply founder mental models (see [references/founder-frameworks.md](references/founder-frameworks.md)):

- **Thiel**: "What important truth do few people agree with you on?" Monopoly vs competition.
- **Graham**: Do things that don't scale. Make something people want. Talk to users.
- **Andreessen**: "Software is eating the world." Timing, market size, 10x better.
- **Bezos**: Customer obsession, flywheel, long-term.
- **Musk**: First principles. Solve the hardest problem. 10x, not 10%.

Generate 3–7 raw ideas. Mix problem-first and technology-first. Prefer contrarian or underrated angles.

### Step 4: Competition (Search)

For each shortlisted idea, search:

- Direct competitors (same problem, similar solution)
- Indirect competitors (same outcome, different approach)
- Substitutes (status quo, manual process, "do nothing")
- Incumbents who could move in

Map: Who exists? Funding? Traction? Gaps they leave?

### Step 5: Evaluate

Score each idea on:

- **Problem**: Real pain? Willingness to pay? Frequency?
- **Market**: TAM/SAM, growth rate, "why now" clarity
- **Solution**: 10x better or 10%? Defensibility? Moat potential
- **Competition**: Crowded vs white space? Can you win?
- **Founder–market fit**: User's edge, passion, unfair advantage
- **Trend alignment**: Riding tailwinds vs fighting headwinds

### Step 6: Present

Use output format below. Lead with strongest ideas. Include trend and competition evidence.

## Output Format

```markdown
# Startup Brainstorm — [Domain/Theme] — [Date]

## Summary

[2–4 sentences: strongest idea(s), why now, key insight.]

## Trends (Sources: [date range])

- **[Trend 1]**: [What's happening + why it matters] — [source/date]
- **[Trend 2]**: [What's happening + why it matters] — [source/date]
- **Why now**: [2–3 bullets on what changed recently]

## Ideas

### Idea 1: [Name]

**One-liner**: [What it does in one sentence]

**Problem**: [Who has it, how painful, how often]
**Solution**: [Core value prop, 10x angle]
**Market**: [TAM/SAM, growth, geography]
**Competition**:

- Direct: [Player A], [Player B] — [gap they leave]
- Indirect: [Player C] — [how you differ]
  **Moat**: [Network effects, data, brand, distribution, etc.]
  **Founder fit**: [How user's edge helps]
  **Trend alignment**: [How trends support this]

**Risk**: [Main risk]
**Why it could win**: [Key insight]

---

### Idea 2: [Name]

[Same structure]

## Competition Landscape (Summary)

| Idea   | Direct Competitors | Gap           |
| ------ | ------------------ | ------------- |
| Idea 1 | [List]             | [Opportunity] |
| Idea 2 | [List]             | [Opportunity] |

## Recommended Next Steps

1. [Validate X with users/customers]
2. [Search/research Y]
3. [Build MVP of Z]
```

## Founder Questions to Ask

For each idea, mentally run through:

- **Thiel**: "What do I believe that's true but almost nobody agrees?"
- **Graham**: "Would 10 people pay for this today?"
- **Andreessen**: "Why couldn't this have been built 5 years ago?"
- **Bezos**: "What does the customer deeply want that we're not giving?"
- **Hoffman**: "Where's the network effect or blitzscaling potential?"

## Anti-Patterns

- ❌ Inventing trends or competition without search
- ❌ Ignoring "why now" — every idea needs a timing thesis
- ❌ 10% better solutions; aim for 10x or contrarian
- ❌ Dismissing competition; map it and find the gap
- ❌ Generic ideas ("another AI wrapper"); push for specificity and edge
- ❌ No founder–market fit; tie ideas to user's strengths
