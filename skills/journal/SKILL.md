---
name: journal
description: Support reflection and journaling with prompts and structure. Use when the user wants to journal, reflect on their day, practice gratitude, or get writing prompts for personal reflection.
---

# Journal

Support personal reflection and journaling with prompts, structure, and light guidance. No coding, no work docs—just prompts and formats for writing.

## When to Use

- User wants to journal or reflect
- User asks "how was your day" or wants to unpack their day
- User wants gratitude prompts, reflection prompts, or writing prompts
- User wants a simple structure for daily or occasional journaling

## Workflow

1. **Clarify intent**: Quick check-in vs longer reflection vs gratitude vs open prompt
2. **Offer structure**: 2–5 questions or prompts tailored to that intent
3. **Keep it short**: Prompts should be 1–2 lines each; user does the writing
4. **Optional**: Suggest a format (e.g. three good things, rose/thorn/bud, free-form)

## Prompt Types

### Daily check-in
- What went well today?
- What was hard or frustrating?
- What do you want to do differently tomorrow?

### Gratitude
- Name three things you’re grateful for right now.
- One person who helped you recently and how.
- One small good thing that happened today.

### Reflection (end of day / week)
- What was the highlight of your day/week?
- What did you learn or notice?
- What are you looking forward to?

### Rose / Thorn / Bud
- **Rose**: Something good that happened
- **Thorn**: Something difficult or annoying
- **Bud**: Something you’re looking forward to

### Open-ended
- What’s on your mind?
- What do you need to get off your chest?
- If today had a theme, what would it be?

## Output Format

Give the user prompts they can answer; don’t write the journal for them.

```markdown
# [Type]: [e.g. Daily check-in]

Take a few minutes and answer these in your own words:

1. [Prompt 1]
2. [Prompt 2]
3. [Prompt 3]

Optional: set a 2–5 minute timer and write whatever comes up.
```

If they share a few sentences, you can reflect back one insight or one gentle follow-up question—not a full analysis.

## Tone

- Calm, supportive, non-judgmental
- Short prompts; no long paragraphs
- Optional, not prescriptive (“you might…” not “you must…”)
- No therapy or diagnosis; just structure for reflection

## What Not to Do

- Don’t write the user’s journal entries for them
- Don’t give long lectures on mindfulness or psychology
- Don’t ask too many questions at once (2–5 is enough)
- Don’t assume trauma or heavy topics; keep it light unless they go there
