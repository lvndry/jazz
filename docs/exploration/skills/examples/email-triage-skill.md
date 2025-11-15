# Example: Email Triage Skill

A production-ready skill for intelligent email management and categorization.

## Directory Structure

```
skills/email-triage/
├── SKILL.md
├── categorization.md
├── response-templates.md
├── escalation.md
├── scripts/
│   ├── triage.py
│   ├── auto-reply.py
│   └── summarize.py
└── templates/
    ├── responses.json
    └── filters.json
```

## SKILL.md

````yaml
---
name: email-triage
version: 1.3.0
description: Intelligent email categorization, prioritization, and automated response generation
author: Productivity Team
tags: [email, productivity, automation, gmail, communication]
category: Communication
complexity: simple

tools:
  required:
    - gmail_list
    - gmail_read
    - gmail_search
    - gmail_send
    - gmail_add_labels
  optional:
    - gmail_batch_modify
    - read_file

triggers:
  keywords:
    - email
    - triage
    - inbox
    - messages
    - categorize
    - organize
  patterns:
    - "triage (my )?emails?"
    - "check (my )?inbox"
    - "organize (my )?mail"
    - "what('s| is) in my inbox"
    - "summarize (my )?emails?"
  context_hints: []

risk_level: low
approval_required: false

sections:
  - categorization.md
  - response-templates.md
  - escalation.md

estimated_duration: 2-5 minutes
prerequisites:
  - Gmail authentication configured
  - Labels created (optional)

last_updated: 2024-01-15
---

# Email Triage Skill

Automatically categorize, prioritize, and manage your inbox with intelligent email triage.

## Overview

Email overload is a productivity killer. This skill helps you quickly process your inbox by:
- Categorizing emails by type and importance
- Identifying urgent messages requiring immediate attention
- Drafting responses for common queries
- Archiving/labeling emails automatically
- Summarizing your inbox state

## Core Capabilities

1. **Smart Categorization**
   - Urgent: Requires immediate response
   - Important: Needs attention today
   - Normal: Standard correspondence
   - Newsletter: Informational content
   - Spam: Unsolicited messages

2. **Auto-Labeling**
   - Apply Gmail labels based on category
   - Custom label rules
   - Bulk organization

3. **Response Drafting**
   - Generate context-aware replies
   - Use templates for common scenarios
   - Maintain professional tone

4. **Inbox Summarization**
   - Daily digest of important messages
   - Highlight action items
   - Track follow-ups needed

## Basic Workflow

When user requests email triage:

### Step 1: Fetch Unread Emails

```typescript
const emails = await executeTool("gmail_list", {
  query: "is:unread",
  max_results: 50,
});
````

### Step 2: Categorize Each Email

Run categorization script:

```bash
python scripts/triage.py --emails <email_list>
```

This analyzes:

- Sender (known contact? VIP? Mailing list?)
- Subject keywords
- Email content
- Urgency indicators
- Previous thread context

### Step 3: Apply Labels

```typescript
for (const email of categorized) {
  await executeTool("gmail_add_labels", {
    email_id: email.id,
    labels: email.categories,
  });
}
```

### Step 4: Generate Summary

Present results to user:

```
📬 Inbox Triage Complete

🚨 Urgent (3):
  • Client escalation - Payment issue
  • Production alert - API down
  • CEO request - Q4 report

⚠️ Important (8):
  • Team meeting rescheduled
  • Pull request review needed
  • Budget approval required
  ...

📰 Newsletters (12):
  • Tech Daily, Morning Brew, etc.

✅ Processed 45 emails in 23 categories
```

### Step 5: Draft Responses (Optional)

For urgent emails, offer to draft responses:

```typescript
const drafts = await executeTool("execute_script", {
  script: "scripts/auto-reply.py",
  args: { urgent_emails: urgentList },
});
```

## Categorization Rules

### Urgent Indicators

- **Keywords**: urgent, ASAP, emergency, critical, immediately
- **Senders**: Boss, direct reports, key clients
- **Subject patterns**: "RE: [Issue]", "FW: Problem", "URGENT"
- **Time-sensitive**: Meeting in <2 hours, deadline today

### Important Indicators

- **Action required**: Decision needed, approval request
- **Team related**: From coworkers on active projects
- **Customer**: Direct customer communication
- **Scheduled**: Meeting invites, calendar items

### Newsletter Detection

- **Unsubscribe link present**
- **List-Unsubscribe header**
- **From bulk sender** (e.g., hello@company.com)
- **Generic greeting** ("Dear subscriber")

### Spam Detection

- **Suspicious sender**
- **Phishing indicators**
- **Excessive links**
- **Poor grammar/spelling**

See [categorization.md](categorization.md) for detailed rules.

## Response Templates

Common scenarios with template responses:

### Meeting Request

```
Thank you for the meeting request. I'm available at the following times:
- [Time slot 1]
- [Time slot 2]
- [Time slot 3]

Please let me know what works best for you.
```

### Information Request

```
Thanks for reaching out. Here's the information you requested:

[Answer based on context]

Let me know if you need anything else.
```

### Acknowledgment

```
Thanks for letting me know. I've noted this and will [action item].
```

See [response-templates.md](response-templates.md) for full library.

## Escalation Rules

Some emails should be escalated to user immediately:

- 🚨 **Executive-level senders**
- 🚨 **Legal/compliance matters**
- 🚨 **Financial transactions**
- 🚨 **Security incidents**
- 🚨 **Unknown urgent requests**

See [escalation.md](escalation.md) for complete escalation matrix.

## Code Resources

### scripts/triage.py

Machine learning-based email categorization.

**Usage:**

```bash
python scripts/triage.py --emails email_list.json --output categorized.json
```

**Features:**

- Uses trained classifier
- Learns from corrections
- Handles multiple languages

### scripts/auto-reply.py

Generate contextual email responses.

**Usage:**

```bash
python scripts/auto-reply.py --email email_id.json --template general
```

**Features:**

- Template-based generation
- LLM-enhanced personalization
- Maintains conversation context

### scripts/summarize.py

Create inbox summary with highlights.

**Usage:**

```bash
python scripts/summarize.py --emails email_list.json --format brief
```

## Configuration

Customize behavior in `templates/filters.json`:

```json
{
  "urgent_senders": ["boss@company.com", "ceo@company.com"],
  "vip_domains": ["@keyclient.com", "@partner.com"],
  "auto_archive": ["newsletters", "notifications"],
  "custom_labels": {
    "team-updates": {
      "from": "@company.com",
      "subject_contains": ["team", "update"]
    }
  }
}
```

## Example Usage

### Example 1: Morning Inbox Check

```
User: "Triage my emails"

Agent: [Loads email-triage skill]
Agent: [Fetches unread emails]
Agent: "Found 45 unread emails. Analyzing..."
Agent: [Runs triage.py]
Agent: "✅ Triage complete!

📬 Your Inbox (45 emails):

🚨 URGENT (3) - Needs immediate attention:
  1. Sarah Chen: "Production API down"
     → Action: Need to investigate server logs
  2. John Smith (CEO): "Q4 Budget Review"
     → Action: Prepare budget slides by EOD
  3. billing@vendor.com: "Payment failed"
     → Action: Update credit card

⚠️ Important (8):
  • Team standup rescheduled to 2pm
  • PR #234 needs your review
  • Customer feedback on new feature
  [5 more...]

📰 Newsletters (25):
  • Morning Brew, TechCrunch Daily, etc.
  → Auto-archived

✅ Normal (9): Team updates, project discussions

Would you like me to draft responses for the urgent emails?"

User: "Yes, draft responses"

Agent: [Runs auto-reply.py for urgent emails]
Agent: "✅ Drafted 3 responses. Review:

1. To Sarah - Production API:
   'I'm investigating now. Will update in 15 minutes.'

2. To John - Budget:
   'I'll have the Q4 budget slides ready by 4pm today.'

3. To billing@vendor.com:
   'Credit card updated. Please retry the payment.'

Send these responses?"
```

### Example 2: End-of-Day Cleanup

```
User: "Organize my inbox before I leave"

Agent: [Loads email-triage skill]
Agent: "Organizing inbox..."
Agent: [Processes all emails]
Agent: "✅ Inbox organized!

📊 Summary:
  • 3 emails marked urgent → Kept in inbox
  • 12 emails labeled and archived
  • 8 newsletters archived
  • 2 spam messages deleted

📋 Action items for tomorrow:
  1. Follow up with marketing on campaign metrics
  2. Review design mockups from Jane
  3. Respond to partnership inquiry

Your inbox is now at 3 unread (urgent only). Have a great evening! 🌙"
```

### Example 3: Weekly Newsletter Cleanup

```
User: "Archive all newsletters from this week"

Agent: [Loads email-triage skill]
Agent: [Searches for newsletters]
Agent: "Found 47 newsletters from the past week"
Agent: [Applies bulk archive]
Agent: "✅ Archived 47 newsletters:
  • Tech: 18
  • Business: 12
  • Marketing: 8
  • Other: 9

Inbox cleared! 🎉"
```

## Best Practices

1. **Run triage daily**
   - Morning: Process overnight emails
   - Afternoon: Quick check before meetings
   - Evening: Final cleanup

2. **Train the categorizer**
   - Correct miscategorizations
   - Add custom rules for your workflow
   - Update VIP senders list

3. **Review auto-responses**
   - Always review before sending
   - Customize templates to your voice
   - Add context when needed

4. **Set up filters**
   - Auto-label team updates
   - Archive newsletters automatically
   - Flag VIP senders

## Metrics

Track email management efficiency:

- **Triage Time**: Average time to process inbox
- **Response Time**: Average time to respond to urgent emails
- **Accuracy**: % of correctly categorized emails
- **Inbox Zero Days**: Days with 0 unread emails

## Related Skills

Works well with:

- **calendar-management**: Schedule meetings from email requests
- **task-management**: Convert emails to tasks
- **notification**: Send daily email digests

## Changelog

### v1.3.0 (2024-01-15)

- Added auto-reply generation
- Improved spam detection
- Added weekly digest feature

### v1.2.0 (2023-12-10)

- Machine learning categorization
- Custom label support
- Bulk operations

### v1.0.0 (2023-11-01)

- Initial release
- Basic categorization
- Gmail integration

````

## Additional Files

### categorization.md

```markdown
# Email Categorization Rules

## Detailed Categorization Logic

### Priority Scoring

Each email receives a priority score (0-100):

```python
def calculate_priority(email):
    score = 50  # Base score

    # Sender importance
    if is_executive(email.sender): score += 30
    if is_direct_report(email.sender): score += 20
    if is_vip_client(email.sender): score += 25
    if is_teammate(email.sender): score += 10

    # Content urgency
    if has_urgent_keywords(email.subject): score += 20
    if has_urgent_keywords(email.body): score += 10
    if has_deadline_today(email.body): score += 15

    # Time sensitivity
    if mentions_meeting_soon(email.body): score += 15
    if is_reply_to_my_email(email): score += 10

    # Negative signals
    if is_automated(email): score -= 20
    if is_newsletter(email): score -= 30
    if is_bulk_sender(email): score -= 15

    return min(100, max(0, score))
````

### Category Thresholds

- **Urgent**: score >= 80
- **Important**: score >= 60
- **Normal**: score >= 40
- **Low Priority**: score < 40

### Special Categories

#### VIP Senders

Always prioritized:

- C-level executives
- Direct manager
- Key clients (configured)
- Investors/board members

#### Auto-Archive

Automatically archived:

- Marketing emails with unsubscribe link
- Automated notifications (CI/CD, monitoring)
- Social media notifications
- Promotional emails

#### Spam Detection

Flagged as spam if:

- Unknown sender + suspicious content
- Phishing indicators (fake domains)
- Excessive links (>10)
- Requests for personal information

````

### response-templates.md

```markdown
# Email Response Templates

## Quick Acknowledgments

### Received & Processing
````

Thanks for your email. I've received this and will get back to you by [timeframe].

```

### Need More Info
```

Thanks for reaching out. To better assist you, could you provide:

- [Question 1]
- [Question 2]

```

## Meeting Requests

### Accept Meeting
```

Thanks for the meeting request. [Time] works great for me. I've accepted the invite.

Looking forward to discussing [topic].

```

### Propose Alternative
```

Thanks for the meeting invite. I'm not available at that time, but I'm free:

- [Alternative 1]
- [Alternative 2]

Would either of these work?

```

## Work Requests

### Acknowledge Task
```

Thanks for sending this over. I'll review and have [deliverable] ready by [deadline].

I'll reach out if I have any questions.

```

### Need Clarification
```

Thanks for the request. Before I proceed, I need clarification on:

1. [Question]
2. [Question]

Could you provide these details?

```

## Follow-ups

### Gentle Reminder
```

Following up on my previous email from [date] regarding [topic].

Do you have any updates on this?

```

### Status Update
```

Quick update on [project]:

- [Completed item]
- [In progress item]
- [Next steps]

Let me know if you need anything else.

```

```

---

This email triage skill demonstrates:

- ✅ AI-powered categorization
- ✅ Response generation
- ✅ Bulk operations
- ✅ Custom rules and filters
- ✅ Integration with productivity workflow
