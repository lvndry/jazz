# Bulk Email Cleanup

Clean up thousands of old emails based on age, sender, or content.

## Example

**Ask:** `"Find all emails older than 90 days from automated services"`

**Jazz will:**

1. Search your email for messages matching the criteria
2. Categorize them by source (GitHub, LinkedIn, newsletters, etc.)
3. Show you a summary with counts
4. Ask for confirmation before deleting

## Setup

Create an agent with Gmail tools:

```bash
jazz agent create
# Name: email-cleanup
# Tools: Gmail
```

## Usage

```bash
jazz agent chat email-cleanup
```

Then ask Jazz to find and clean up emails. Jazz will:

- Search based on your criteria (age, sender, content)
- Show you what will be deleted
- Require explicit confirmation for permanent deletion
- Provide a summary after cleanup

## Example Output

```
You: Find all emails older than 90 days from automated services

Agent: Found 247 emails:
- GitHub notifications: 156 emails
- LinkedIn messages: 45 emails
- Newsletter archives: 46 emails

You: Delete all GitHub and newsletter ones, keep LinkedIn

Agent: ⚠️ PERMANENT DELETION WARNING
About to delete 202 emails. Type 'DELETE' to confirm:

You: DELETE

Agent: ✓ Deleted 202 emails successfully
```

## More Examples

- `"Delete all emails from newsletters older than 6 months"`
- `"Find and delete all GitHub notification emails"`
- `"Clean up emails from automated services"`
- `"Remove all emails with attachments older than 1 year"`

## Tips

- Jazz requires explicit confirmation for permanent deletions
- You can preview what will be deleted before confirming
- Jazz can search by sender, subject, date, or content
- Be careful with deletion commands - they're permanent
