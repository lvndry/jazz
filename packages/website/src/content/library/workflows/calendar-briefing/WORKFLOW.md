---
name: calendar-briefing
description: Each weekday morning, today's meetings with what to prepare for each one.
schedule: "30 7 * * 1-5"
autoApprove: read-only
maxIterations: 20
maxCostUSD: 0.30
skills:
  - calendar
author: jazz
tags: [calendar, daily, personal]
---

# Calendar briefing

Prepare my briefing for today. Read only; never create, move, or accept anything.

## Setup

The calendar skill shells out to a calendar CLI, and a `read-only` run cannot approve shell
commands on its own. Allow that binary once in `~/.jazz/config.json`, for example
`{"autoApprovedCommands": ["khal"]}` or `["gcalcli"]`, and this workflow runs unattended.

## Gather

Today's events with their times, attendees, locations or links, and descriptions. Also the first
event of tomorrow, so a very early start is not a surprise.

## Report

For each meeting, in order, one line with the time, the title, and the people. Under it, at most
two short lines:

- **Prepare**: what the description or attendees imply I should have ready. If nothing is
  implied, leave the line out.
- **Conflict**: overlaps with another event, or back-to-back with a location change.

End with the free blocks longer than 45 minutes, and tomorrow's first event. Keep the whole
thing shorter than the meetings it describes.
