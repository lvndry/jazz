---
name: decision-log
description: Record and retrieve decisions with context, options, and rationale. Use when documenting a decision, reviewing past decisions, or answering "why did we choose X?"
---

# Decision Log

Record decisions with context, options considered, and rationale. Retrieve and explain past decisions so teams and future-you know why something was chosen.

## When to Use

- User wants to document a decision (ADR, decision record, "why we chose X")
- User asks "why did we choose X?" or "what was the decision on Y?"
- User wants to review options before deciding
- User is building or maintaining a decision log

## Workflow

1. **Context**: What is the decision about? (scope, constraint, trigger)
2. **Options**: What were the options considered? (2–5)
3. **Criteria**: What matters? (cost, speed, risk, maintainability, etc.)
4. **Decision**: What was chosen?
5. **Rationale**: Why? What trade-offs?
6. **Consequences**: What follows? (follow-up work, reversibility, review date)

## Decision Record Format

```markdown
# [Decision Title]

**Date**: YYYY-MM-DD  
**Status**: Proposed | Accepted | Deprecated | Superseded by [link]  
**Deciders**: [who was involved]

## Context

[What situation or problem led to this decision? What constraints exist?]

## Options Considered

### Option A: [Name]

- **Pros**: [list]
- **Cons**: [list]

### Option B: [Name]

- **Pros**: [list]
- **Cons**: [list]

### Option C: [Name]

- ...

## Decision

**[Chosen option]** because [1–2 sentence rationale].

## Rationale

[Why this option? What trade-offs were accepted? What was rejected and why?]

## Consequences

- [What we gain]
- [What we give up or risk]
- [Follow-up work]
- [When to revisit: e.g. in 6 months, or when X happens]

## References

- [Link to ticket, doc, or discussion]
```

Keep each record to one decision. Use "Superseded by" when a later decision replaces this one.

## When to Create a Record

- **Technical**: Architecture, stack, library, API design, data model
- **Process**: How we run meetings, deploy, review, onboard
- **Product**: Feature scope, prioritization, rollout strategy

Skip for tiny, reversible choices (e.g. variable name). Use for choices that affect others or are hard to undo.

## Retrieving Decisions

When someone asks "why did we choose X?":

1. Search decision log (or codebase for ADR files)
2. Return the matching record: context, options, decision, rationale
3. If superseded, point to the newer decision and brief reason

If no record exists: say so and offer to draft one from what's known or from conversation.

## Lightweight Variant

For quick logs without full ADR format:

```markdown
## [Date] [Decision in one line]

- **Context**: [1 sentence]
- **Options**: A, B, C
- **Chosen**: A. **Why**: [1 sentence]
- **Follow-up**: [any]
```

## Tone and Style

- Neutral and factual
- Past tense for what was decided
- Clear "we chose X because Y"
- No blame; focus on rationale and trade-offs

## Anti-Patterns

- ❌ Recording every tiny choice; reserve for meaningful decisions
- ❌ Only stating the outcome without options or rationale
- ❌ No date or status (hard to know if it's still current)
- ❌ Mixing multiple decisions in one record
