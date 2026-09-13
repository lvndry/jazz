---
name: habit-check
description: Read your habit log back as streaks each night, and as a month review when the monthly schedule fires. One file, two frequencies.
schedule: "0 21 * * *"
autoApprove: read-only
maxIterations: 20
maxCostUSD: 0.25
author: jazz
tags: [habits, personal, two-frequencies]
---

# Habit check

Read my habit log and tell me how I am doing. Read only; never edit the log.

## The log

`~/habits.md`, one line per day, a checkmark per habit, in this shape:

```
2026-09-01  run ✓  read ✓  no-sugar ✗  sleep-by-11 ✓
2026-09-02  run ✗  read ✓  no-sugar ✓  sleep-by-11 ✗
```

If the file is missing, reply with that format and a one-line instruction to create it, then stop.

## Two schedules, one file

This run is the `{schedule.label}` check. Install it twice:

```
jazz workflow schedule habit-check                                  # habit-check/default, nightly
jazz workflow schedule habit-check --cron "0 9 1 * *" --as monthly  # habit-check/monthly
```

## Nightly (label `default` or `manual`)

Look at today and the last fourteen days. Reply with at most six lines:

- one line per habit with its current streak, as "run: 5 days" or "run: broken today, best 9",
- the one habit most at risk this week, in one sentence,
- nothing else. No encouragement, no advice.

## Monthly (label `monthly`)

Look at the whole previous calendar month. Reply with:

1. **Completion**: each habit as done days over logged days, sorted from best to worst.
2. **Patterns**: which weekdays fail most, and whether two habits fail together.
3. **Longest streak** and **longest gap** per habit.
4. **One change**: the single habit to drop, keep, or reshape next month, with the reason from the
   data.

Do not run both sections. Pick by `{schedule.label}` and stop.
