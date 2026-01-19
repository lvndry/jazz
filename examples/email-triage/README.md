# Smart Email Triage

Automate inbox management with intelligent categorization and prioritization.

## Example

**Ask:** `"Show me unread emails from the last 2 days and organize them"`

**Jazz will:**

1. Read your unread emails from the specified time period
2. Categorize them by type (work, newsletters, social, etc.)
3. Provide a summary with counts
4. Offer actions like archiving, labeling, or drafting replies

## Setup

Create an agent with Gmail tools:

```bash
jazz agent create
# Name: email-triage
# Tools: Gmail
```

## Usage

```bash
jazz agent chat email-triage
```

Then ask Jazz to organize your inbox. Jazz will:

- Read and categorize your emails
- Show you a summary
- Offer specific actions
- Ask for approval before making changes

## Example Output

```
You: Show me unread emails from the last 2 days and organize them

Agent: Found 23 unread emails:

📊 Work (12 emails)
- 5 from team members
- 4 pull request notifications
- 3 meeting invites

📰 Newsletters (8 emails)
🔔 Social (3 emails)

You: Archive all newsletters and label work emails by sender

Agent: ⚠️ About to:
- Archive 8 newsletter emails
- Add labels to 12 work emails

Proceed? (yes/no)

You: yes

Agent: ✓ Done! Inbox organized.
```

## More Examples

- `"Organize my inbox by priority"`
- `"Show me urgent emails from the last week"`
- `"Label all emails from my team"`
- `"Archive all newsletters older than 30 days"`

## Tips

- Jazz can categorize emails by sender, subject, or content
- All actions require your explicit approval
- You can ask Jazz to draft replies for important emails
- Jazz maintains context, so you can refine your requests
