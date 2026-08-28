---
name: meeting-notes
description: Summarize meetings and extract action items. Use when processing meeting transcripts, notes, or recordings to get summaries, decisions, and follow-ups.
---

# Meeting Notes

Turn a meeting transcript, pasted notes, or rough draft into a clean summary with explicit decisions, owners, and follow-ups. The goal is one artifact a busy reader can act on in 30 seconds.

## When to Use

- User has meeting notes, a transcript, or a recording and wants a summary
- User wants action items or follow-ups extracted
- User asks "what did we decide?" or "what are the next steps?"
- User wants a follow-up email drafted to attendees

## Input Handling

Accept input in any of these forms:

- **Pasted text** — transcript, bullet notes, or a rough draft in the conversation
- **File path** — if the user gives a path or filename, read it with `read_file` first; don't ask them to paste a long file
- **Multiple fragments** — several messages or files mean one meeting; merge them into a single summary, don't summarize each separately

If something material is missing (which meeting? which date?), ask one targeted question rather than guessing. Don't block on minor unknowns like exact attendee spelling — mark them `TBD`.

## Workflow

1. **Ingest** the source (read the file if a path was given).
2. **Summarize** in 3–5 sentences: what was discussed, what was decided, the meeting's tone.
3. **Extract decisions** — explicit agreements and choices made, with owner/context if stated.
4. **Extract action items** — concrete tasks; capture owner and due date when present, else `TBD`.
5. **Surface open questions, risks, and next-meeting needs** so nothing important is buried.
6. **Format** the artifact (below) and present it.
7. **Save** it if the user wants it kept (see Saving).

## Output Format

```markdown
---
title: [Topic]
date: [YYYY-MM-DD or TBD]
attendees: [Name, Name, … or TBD]
source: [pasted | path/to/file]
tags: [meeting, <project>]
---

# Meeting Summary: [Topic or title]

## Summary
[3–5 sentences: what was discussed, main outcomes, tone of meeting]

## Decisions
- [Decision 1]. [Owner / context if known.]
- [Decision 2]

## Action Items
| Owner  | Action | Due              | Status |
| ------ | ------ | ---------------- | ------ |
| [Name] | [What] | [When if stated] | TBD    |
| …      | …      | …                | …      |

## Open Questions
- [Question or topic to revisit]
- [Blocked item or dependency]

## Risks & Concerns
- [Risk or objection someone raised, briefly]

## Follow-up
- [Next meeting / check-in if scheduled]
- [Item to carry into the next conversation]
```

`Status: TBD` stays until the owner tracks it elsewhere — this skill extracts, it doesn't track.

## What to Extract

- **Decisions**: explicit agreements, choices made, "we will do X." Distinguish a decision from an opinion or a proposal still under discussion.
- **Action items**: concrete tasks with an owner. When the owner or date isn't stated, write `TBD` — never invent one.
- **Open questions**: unresolved threads, dependencies on other teams, things explicitly deferred.
- **Risks / concerns**: objections, blockers, or caveats anyone raised.
- **Follow-up**: next check-in, recomputed deadlines, or items to carry forward.

## Tone and Style

- Neutral and factual; no editorializing.
- Past tense for what happened ("The team agreed…").
- Present/future for actions ("Alice will send the doc by Friday").
- Bullets and tables over prose walls.
- Stick to what was said or clearly implied.

## Saving

If the user wants the notes kept:

- Default path: `meeting-notes/YYYY-MM-DD-<slug>.md` in the current workspace (create the directory if missing).
- If the user names a location or an existing file, write there instead — overwriting an existing notes file is fine for an update; don't duplicate.
- Use `write_file` to persist, then confirm the path.
- If the user only wants it in chat, skip saving — don't force a file.

## Follow-up Email (optional)

Generate only when the user asks for "follow-up email" or "send to attendees":

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

## Short vs Long Input

- **Short notes**: brief summary + bullets for decisions and actions.
- **Long transcript**: summary first, then decisions, then actions, then Open Questions / Risks if useful. Never paste the whole transcript back — extract.

## Anti-Patterns

- ❌ Inventing owners, due dates, or decisions not in the source
- ❌ Treating opinions or open proposals as decisions
- ❌ A wall of prose where bullets/tables would do
- ❌ Omitting clear action items or decisions
- ❌ Re-summarizing each fragment when given several — merge into one meeting
- ❌ Refusing to save when asked, or saving without being asked
