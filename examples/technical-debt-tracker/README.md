# Technical Debt Tracker

Find, prioritize, and systematically address technical debt in your codebase.

## Example

**Ask:** `"Find all TODO comments in src/ and create a prioritized action plan"`

**Jazz will:**

1. Scan the codebase for TODO comments, FIXME, HACK, etc.
2. Analyze the context of each technical debt item
3. Prioritize by urgency and impact
4. Create an actionable plan
5. Optionally help fix high-priority items

## Setup

Create an agent with file system, shell, and git tools:

```bash
jazz agent create
# Name: debt-tracker
# Tools: File System, Shell, Git
```

## Usage

```bash
jazz agent chat debt-tracker
```

Then ask Jazz to find and prioritize technical debt. Jazz will:

- Search for TODO comments and similar markers
- Analyze the code context
- Prioritize by urgency
- Show you the code for each item
- Help fix items with your approval

## Example Output

```
You: Find all TODO comments in src/ and create a prioritized action plan

Agent: Found 23 TODO comments:

🔴 High Priority (5):
1. src/auth/jwt.ts:45 - "Add token refresh before security audit"
2. src/api/billing.ts:123 - "URGENT - Fix race condition in payments"
3. src/db/migrations.ts:67 - "Add rollback support before v2.0"

🟡 Medium Priority (12)
🟢 Low Priority (6)

You: Show me the code for item #2 and suggest a fix

Agent: Current code has a race condition in payment processing.

Suggested fix:
- Use database transaction with row-level locking
- Add idempotency key handling
- Implement retry logic

Should I apply this fix?

You: yes, and run tests

Agent: ✓ File updated with transaction locking
✓ TODO comment removed
✓ All tests passing (12/12 payment tests passed)
```

## More Examples

- `"Find all FIXME comments and prioritize them"`
- `"Track technical debt in the authentication module"`
- `"Create a technical debt report for the entire codebase"`
- `"Find and fix all HACK comments"`

## Tips

- Jazz can search for various technical debt markers (TODO, FIXME, HACK, XXX, etc.)
- Priority is determined by keywords (URGENT, CRITICAL) and context
- Jazz can suggest fixes and apply them with your approval
- You can focus on specific modules or the entire codebase



