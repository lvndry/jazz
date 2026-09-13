---
name: anki-cards
description: Turn the notes you wrote this week into Anki flashcards, ready to import.
schedule: "0 19 * * 0"
autoApprove: read-only
maxIterations: 25
maxCostUSD: 0.50
author: jazz
tags: [learning, notes, personal]
---

# Anki cards

Make flashcards from what I learned this week. Read only; reply with the cards.

## Source

Edit this. The folder my notes live in, and anything to skip:

- Notes folder: `~/notes`
- Skip: `~/notes/journal`, anything named `TODO`

## Gather

Every Markdown or text file in the notes folder modified after `{schedule.lastRunAt}`, or in the
last seven days if that is empty. Read them in full; do not sample.

## Write cards

Only for things worth remembering in a month: definitions, the reason behind a decision, a
command and what it does, a number that matters. Skip anything that is a to-do, an opinion, or
already obvious from its name.

Rules for a good card:

- One fact per card. Split anything with "and" in the answer.
- The question must be answerable without the note. Name the subject; "What does this do?" is
  not a question.
- Answers under fifteen words. Put the longer explanation on the back after a blank line only
  when the short answer would be misleading alone.
- Add cloze cards (`{{c1::...}}`) for lists and sequences instead of asking for the whole list.

## Output

A fenced block in Anki's import format, tab separated, one card per line, with the source file
name as a tag on every card:

```
Front	Back	tags
```

Aim for ten to twenty cards. Fewer good cards beat many weak ones; if the week produced nothing
worth a card, say so in one line and stop.
