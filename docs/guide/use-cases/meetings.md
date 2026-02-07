# Use Case: Meeting Assistant

## Overview

Prepare for meetings with automated context gathering and generate minutes afterwards.

## Pre-Meeting Brief

**Prompt:**

> "I have a meeting with [Company X] tomorrow. Search for their recent news, funding rounds, and latest product launches. Create a one-page cheat sheet for me."

## Post-Meeting Minutes

**Prompt:**

> "Here are my rough notes from the meeting: [paste notes]. Clean these up into formal meeting minutes. Extract action items into a checklist. Create a Google Calendar event for the follow-up in 2 weeks."

## Automation

You can combine these with the `calendar` skill to automatically check your schedule and prep briefs for external meetings every morning.

`grooves/morning-brief/GROOVE.md`:

```markdown
1. Check my calendar for today.
2. For any event with external guests, research their company.
3. specific: "summarize recent news for {company_domain}".
4. Email me the briefing.
```
