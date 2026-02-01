---
name: meeting-notes
description: Summarize meetings and extract action items. Use when processing meeting transcripts, notes, or recordings to get summaries, decisions, and follow-ups.
---

# Meeting Notes

Summarize meetings and extract decisions, action items, and follow-ups from transcripts or notes.

## When to Use

- User has meeting notes or a transcript and wants a summary
- User wants action items or follow-ups extracted
- User asks "what did we decide?" or "what are the next steps?" from notes

## Workflow

1. **Ingest**: Transcript, bullet notes, or rough draft
2. **Summarize**: 3–5 sentence overview of what was discussed and decided
3. **Extract decisions**: What was agreed or decided (with owner if clear)
4. **Extract action items**: Who does what by when (if stated or inferable)
5. **Format**: Clean summary + decisions + action items + optional follow-up email

## Output Format

```markdown
# Meeting Summary: [Topic or title]
**Date**: [if known]  
**Attendees**: [if known]

## Summary
[3–5 sentences: what was discussed, main outcomes, tone of meeting]

## Decisions
- [Decision 1]. [Owner/context if known.]
- [Decision 2]

## Action Items
| Owner  | Action | Due              |
| ------ | ------ | ---------------- |
| [Name] | [What] | [When if stated] |
| ...    | ...    | ...              |

## Follow-up
- [Topic or question to revisit]
- [Blocked item or open question]

## Raw notes / transcript
[Optional: link or truncated copy if user wants it preserved]
```

## What to Extract

**Decisions**: Explicit agreements, choices made, “we will do X.”
**Action items**: Concrete tasks with owner; add “(owner TBD)” if unclear.
**Follow-up**: Topics to revisit, open questions, blocked items.
**Risks or concerns**: If someone raised a risk or objection, note it briefly.

Do not invent owners or due dates; use “?” or “TBD” when missing.

## Tone and Style

- Neutral and factual
- Past tense for what happened (“The team agreed…”)
- Present/future for actions (“Alice will send the doc by Friday”)
- No editorializing; stick to what was said or clearly implied

## Follow-up Email (optional)

If user wants a short follow-up email:

```markdown
**Subject**: Follow-up: [Meeting topic]

Hi all,

Quick summary from [meeting]:
- [Key point 1]
- [Key point 2]

Action items:
- [Name]: [Action] by [date]
- [Name]: [Action]

[Open question or next meeting if any.]

Thanks,
[User]
```

Generate only if user asks for “follow-up email” or “send summary to attendees.”

## Short vs Long Input

- **Short notes**: Brief summary + bullets for decisions and actions.
- **Long transcript**: Summary first, then decisions, then actions, then “Key quotes” or “Context” if useful. Do not repeat the whole transcript.

## Anti-Patterns

- ❌ Making up owners or due dates not in the source
- ❌ Treating opinions as decisions
- ❌ Huge wall of prose; use bullets and tables
- ❌ Omitting clear action items or decisions
