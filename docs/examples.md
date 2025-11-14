# Jazz Use Case Examples

This guide showcases real-world examples of what you can accomplish with Jazz agents. From simple automation to complex workflows, these examples demonstrate the power of agentic AI.

## 📧 Email Management

### Smart Email Triage

Automate your inbox management with intelligent categorization and prioritization.

**Create a triage agent:**

```bash
jazz agent create --name "email-triage"
# Select: Gmail tools, OpenAI GPT-4o or Anthropic Claude 3.5 Sonnet
```

**Example conversation:**

```
You: Show me all unread emails from the last 2 days

Agent: [Searches inbox]
Found 23 unread emails. Let me categorize them:

📊 **Work (12 emails)**
- 5 from team members
- 4 pull request notifications
- 3 meeting invites

📰 **Newsletters (8 emails)**
- JavaScript Weekly, Node Weekly, etc.

🔔 **Social (3 emails)**
- LinkedIn notifications, Twitter mentions

You: Archive all newsletters and label work emails by sender

Agent: ⚠️ About to:
- Archive 8 newsletter emails
- Add labels to 12 work emails:
  * "from:sarah" → 5 emails
  * "from:github" → 4 emails
  * "from:calendar" → 3 emails

Proceed? (yes/no)

You: yes

Agent: ✓ Done! Inbox organized:
- 8 newsletters archived
- 12 work emails labeled
- Your inbox now has 3 unread emails remaining
```

### Automated Response Drafting

Let Jazz draft professional replies to common email patterns.

```
You: Draft replies to all emails from my manager from today

Agent: [Finds 2 emails from manager]

Email 1: "Can you send me the Q4 report?"
Draft: "Hi [Manager Name], I'll send the Q4 report by end of day.
Is there a specific section you'd like me to prioritize?"

Email 2: "Let's schedule a 1:1 for next week"
Draft: "Happy to meet! I'm available Monday 2-4pm,
Wednesday 10am-12pm, or Thursday afternoon. What works for you?"

Would you like me to save these as drafts?

You: yes, save them

Agent: ✓ Saved 2 draft replies in Gmail
```

### Email Cleanup Workflow

Bulk organize your inbox based on age, sender, or content.

```
You: Find all emails older than 90 days from automated services
     and prepare them for deletion

Agent: [Searches email]
Found 247 emails matching criteria:
- GitHub notifications: 156 emails
- LinkedIn messages: 45 emails
- Newsletter archives: 46 emails

Oldest: 342 days old
Newest: 91 days old

Would you like to review a sample before deletion?

You: Show me 3 examples from each category

Agent: [Shows email previews...]

You: Delete all GitHub and newsletter ones, keep LinkedIn

Agent: ⚠️ PERMANENT DELETION WARNING
About to delete 202 emails (156 GitHub + 46 newsletters)
This cannot be undone!

Type 'DELETE' to confirm:

You: DELETE

Agent: ✓ Deleted 202 emails successfully
Kept 45 LinkedIn emails as requested
```

## 🔧 Git Operations

### Intelligent Commit History Rewriting

Clean up messy commit history with AI assistance.

```bash
jazz agent create --name "git-cleaner"
# Select: Git tools, File Management tools
```

**Example conversation:**

```
You: Show me the last 10 commits on this branch

Agent: [Runs git log]
Here are your last 10 commits:

1. abc123 - "fix" (2 hours ago)
2. def456 - "wip" (3 hours ago)
3. ghi789 - "more changes" (4 hours ago)
4. jkl012 - "update" (5 hours ago)
5. mno345 - "feat: add user auth" (6 hours ago)
6. pqr678 - "typo" (1 day ago)
7. stu901 - "feat: add login page" (1 day ago)
8. vwx234 - "fix tests" (1 day ago)
9. yza567 - "refactor: clean code" (2 days ago)
10. bcd890 - "feat: initial auth setup" (2 days ago)

You: I want to squash commits 1-4 into commit 5 with a better message

Agent: [Analyzes commits 1-5]

I'll help you squash commits abc123, def456, ghi789, jkl012 into mno345.

Looking at the file changes across these commits:
- src/auth/login.ts (multiple updates)
- src/auth/middleware.ts (added)
- tests/auth.test.ts (modified)

Suggested commit message:
"feat: implement user authentication with JWT middleware

- Add login endpoint with validation
- Implement JWT token generation and verification
- Add authentication middleware for protected routes
- Add comprehensive auth tests"

Sound good?

You: Perfect! Do it

Agent: ⚠️ Git History Rewrite Warning
About to perform interactive rebase:
- Squashing 4 commits into 1
- New message: "feat: implement user authentication..."
- Affects commits: abc123 through mno345

This will rewrite history. If pushed, requires force-push.

Proceed? (yes/no)

You: yes

Agent: [Executes git rebase]
✓ Rebase successful!
✓ 4 commits squashed into 1
✓ New commit hash: xyz999

Your git log is now cleaner. Would you like to see it?
```

### Automated Branch Cleanup

Find and delete stale branches that have been merged.

```
You: Show me all branches that have been merged to main
     and haven't been updated in 30+ days

Agent: [Analyzes branches]
Found 7 stale merged branches:

1. feature/old-login (merged 45 days ago)
2. bugfix/header-fix (merged 38 days ago)
3. feature/dashboard-v1 (merged 62 days ago)
4. hotfix/api-timeout (merged 33 days ago)
5. feature/user-profile (merged 51 days ago)
6. refactor/cleanup (merged 42 days ago)
7. bugfix/memory-leak (merged 35 days ago)

Would you like me to delete these?

You: yes, delete them all

Agent: ⚠️ About to delete 7 branches (local):
- feature/old-login
- [... rest of list]

These branches are merged and won't affect main.
Proceed? (yes/no)

You: yes

Agent: ✓ Deleted 7 local branches
Note: Remote branches still exist. Delete those too?

You: yes

Agent: ⚠️ About to delete 7 remote branches on origin
This affects other team members' view.
Proceed? (yes/no)

You: yes

Agent: ✓ Deleted 7 remote branches
Your repository is now cleaner!
```

## 🚀 Project Setup Automation

### Clone and Follow README

Automatically clone a repository and execute setup instructions.

```bash
jazz agent create --name "project-setup"
# Select: Git tools, Shell tools, File Management tools
```

**Example conversation:**

```
You: Clone https://github.com/someuser/awesome-project
     and follow the README setup instructions

Agent: ✓ Cloning repository...
✓ Repository cloned to ./awesome-project

[Reads README.md]

Found setup instructions:
1. Install dependencies: `npm install`
2. Copy .env.example to .env
3. Run database migrations: `npm run migrate`
4. Start dev server: `npm run dev`

Should I execute these steps?

You: yes, but ask me before running migrations

Agent: [Executes steps 1-2]

Step 1: Running `npm install`
[Shows npm output...]
✓ Dependencies installed (234 packages)

Step 2: Copying environment file
✓ Created .env from .env.example

Step 3: Database migrations
⚠️ About to run: `npm run migrate`
This will modify your database.

Proceed? (yes/no)

You: yes

Agent: [Runs migrations]
✓ Migrations completed successfully (applied 12 migrations)

Step 4: Start dev server?
Note: This will keep running. Start in background?

You: no, just tell me how to start it

Agent: ✓ Setup complete! To start the dev server, run:
  cd awesome-project && npm run dev

Summary:
✓ Repository cloned
✓ Dependencies installed
✓ Environment configured
✓ Database migrated
✓ Ready to develop!
```

### Multi-Repository Setup

Clone and set up multiple related repositories.

```
You: I need to set up the microservices project. Clone all repos
     from github.com/company/microservices-* and set up each one

Agent: [Searches GitHub]
Found 4 repositories:
1. microservices-api
2. microservices-web
3. microservices-worker
4. microservices-shared

Cloning all 4 repositories...

[Clones each repo]
✓ All repositories cloned

Now analyzing setup requirements:
- microservices-api: Node.js, needs PostgreSQL
- microservices-web: React, needs Node.js
- microservices-worker: Python, needs Redis
- microservices-shared: TypeScript library

Should I proceed with individual setups?

You: yes, set up each one

Agent: [Executes setup for each repo]

1. microservices-api
   ✓ npm install
   ✓ .env configured
   ⚠️ Needs PostgreSQL running. Is it available?

You: yes at localhost:5432

Agent: ✓ Database connection verified
   ✓ Migrations applied

2. microservices-web
   ✓ npm install
   ✓ .env configured (pointing to api at localhost:3000)

3. microservices-worker
   ✓ pip install -r requirements.txt
   ⚠️ Needs Redis. Is it running?

You: yes at localhost:6379

Agent: ✓ Redis connection verified

4. microservices-shared
   ✓ npm install
   ✓ Built successfully

✓ All microservices ready!

Start commands:
- API: cd microservices-api && npm run dev
- Web: cd microservices-web && npm start
- Worker: cd microservices-worker && python worker.py
```

## 🔍 Code Analysis & Refactoring

### Find and Fix TODO Comments

Systematically address technical debt.

````
You: Find all TODO comments in src/ and create a prioritized list

Agent: [Searches codebase]
Found 23 TODO comments:

🔴 High Priority (5):
1. src/auth/jwt.ts:45 - "TODO: Add token refresh logic before security audit"
2. src/api/billing.ts:123 - "TODO: URGENT - Fix race condition in payment processing"
3. src/db/migrations.ts:67 - "TODO: Add rollback support before v2.0"

🟡 Medium Priority (12):
4. src/utils/cache.ts:89 - "TODO: Implement cache invalidation strategy"
5. src/components/UserProfile.tsx:34 - "TODO: Add loading states"
[... more items]

🟢 Low Priority (6):
[... items]

You: Show me the code for item #2 and suggest a fix

Agent: [Reads src/api/billing.ts]

Current code (lines 120-135):
```typescript
async function processPayment(userId: string, amount: number) {
  const user = await getUser(userId);
  // TODO: URGENT - Fix race condition in payment processing
  const balance = user.balance;
  if (balance >= amount) {
    user.balance -= amount;
    await updateUser(user);
    await createTransaction(userId, amount);
  }
}
````

**Issue**: Race condition - two simultaneous payments could both pass
the balance check and cause overdraft.

**Suggested fix**:

```typescript
async function processPayment(userId: string, amount: number) {
  // Use database transaction with row-level locking
  await db.transaction(async (trx) => {
    const user = await trx("users")
      .where({ id: userId })
      .forUpdate() // Lock row
      .first();

    if (!user || user.balance < amount) {
      throw new InsufficientFundsError();
    }

    await trx("users")
      .where({ id: userId })
      .update({ balance: user.balance - amount });

    await trx("transactions").insert({
      user_id: userId,
      amount,
      type: "payment",
      timestamp: new Date(),
    });
  });
}
```

Should I apply this fix?

You: yes, but keep the old code commented

Agent: ⚠️ About to modify src/api/billing.ts

- Will replace lines 120-135
- Old code will be preserved in comments
- Adds database transaction logic

Proceed? (yes/no)

You: yes

Agent: ✓ File updated successfully
✓ TODO comment removed
Would you like me to run tests to verify?

You: yes

Agent: [Runs tests]
✓ All tests passing
Payment processing tests: 12/12 passed

```

### Consistent Code Style Enforcement

Apply style changes across multiple files.

```

You: Find all function declarations that don't have return type annotations
in src/ and add them

Agent: [Analyzes TypeScript files]
Found 47 functions without return type annotations:

Examples:

1. src/utils/format.ts:12 - function formatDate(date: Date)
2. src/api/users.ts:34 - function validateEmail(email: string)
3. src/hooks/useAuth.ts:8 - function useAuth()

Should I analyze these functions and add return types?

You: yes, show me a few examples first

Agent: [Analyzes function implementations]

1. function formatDate(date: Date) → function formatDate(date: Date): string
2. function validateEmail(email: string) → function validateEmail(email: string): boolean
3. function useAuth() → function useAuth(): { user: User | null; login: () => void; logout: () => void }

These look correct based on the function implementations.
Apply all 47 changes?

You: yes

Agent: ⚠️ About to modify 23 files

- Will add return type annotations to 47 functions
- No logic changes, only type safety improvements

Proceed? (yes/no)

You: yes

Agent: [Applies changes]
✓ Updated 47 functions across 23 files
✓ TypeScript compilation successful
✓ No new type errors introduced

Summary: Your codebase now has 100% type coverage for function returns!

```

## 📊 Data Analysis & Reports

### Generate Repository Analytics

Get insights about your codebase activity.

```

You: Analyze the git history for the last 3 months and give me
a contributor report

Agent: [Analyzes git log]

📊 Repository Analytics (Last 90 days)

**Commit Activity:**

- Total commits: 342
- Average per day: 3.8
- Busiest day: Tuesday (68 commits)
- Quietest day: Sunday (12 commits)

**Top Contributors:**

1. alice@company.com - 156 commits (45.6%)
   - 89 feature commits
   - 45 bug fixes
   - 22 refactors

2. bob@company.com - 98 commits (28.7%)
   - 56 feature commits
   - 42 bug fixes

3. charlie@company.com - 88 commits (25.7%)
   - 62 documentation updates
   - 26 feature commits

**Most Active Files:**

1. src/api/users.ts (43 changes)
2. src/components/Dashboard.tsx (38 changes)
3. tests/integration.test.ts (31 changes)

**Commit Message Quality:**

- Following conventional commits: 87%
- With issue references: 72%
- Properly scoped: 91%

Would you like me to save this as a markdown report?

```

### Code Metrics Report

Analyze code quality across your project.

```

You: Generate a code quality report for src/ - check for long files,
complex functions, and test coverage

Agent: [Analyzes codebase]

📈 Code Quality Report

**File Size Analysis:**
🔴 Large files (>500 lines):

1. src/api/billing.ts - 847 lines
2. src/components/Dashboard.tsx - 623 lines
3. src/utils/helpers.ts - 591 lines

💡 Suggestion: Consider splitting these files

**Function Complexity:**
🔴 High complexity (>10):

1. src/api/billing.ts:processPayment() - complexity: 15
2. src/utils/validators.ts:validateForm() - complexity: 13
3. src/api/users.ts:updateUserProfile() - complexity: 12

💡 Suggestion: Refactor complex functions

**Code Organization:**
✓ Average function length: 23 lines (good)
✓ Average file length: 187 lines (good)
⚠️ Max nesting depth: 6 levels (consider flattening)

**Import Analysis:**

- Most imported module: lodash (23 files)
- Potential circular dependencies: 2 found
  1. auth.ts ⟷ user.ts
  2. api.ts ⟷ middleware.ts

Should I investigate the circular dependencies?

You: yes, show me the circular dependency between auth and user

Agent: [Analyzes imports]

Circular dependency found:
auth.ts imports from user.ts (line 3)
user.ts imports from auth.ts (line 7)

auth.ts:

```typescript
import { User } from './user';  // ← imports User type

export function authenticateUser(token: string): User { ... }
```

user.ts:

```typescript
import { authenticateUser } from "./auth"; // ← imports auth function

export function getCurrentUser(): User {
  return authenticateUser(getToken());
}
```

**Solution**: Extract User type to separate types.ts file:

Would you like me to refactor this?

````

## 🌐 Web Research & Documentation

### Competitive Analysis

Research competitors and summarize findings.

```bash
jazz agent create --name "researcher"
# Select: Web Search tools, File Management tools
````

**Example conversation:**

```
You: Research the top 3 project management tools, compare their
     features, and create a markdown report

Agent: [Searches web for project management tools]

Researching:
1. Asana
2. Monday.com
3. Jira

[Performs deep searches...]

Found information:
- Asana: Pricing, features, user reviews, integrations
- Monday.com: Workflow automation, templates, pricing
- Jira: Agile features, reporting, developer tools

Compiling comparison report...

✓ Report created! Here's a preview:

# Project Management Tools Comparison

## Executive Summary
Compared 3 leading project management platforms based on features,
pricing, and user experience.

## Feature Comparison

| Feature | Asana | Monday.com | Jira |
|---------|-------|------------|------|
| Task Management | ✓ | ✓ | ✓ |
| Agile Boards | Limited | ✓ | ✓✓ |
| Automation | ✓ | ✓✓ | ✓ |
| Reporting | ✓ | ✓✓ | ✓✓ |
| Integrations | 200+ | 50+ | 3000+ |

[... more content]

Should I save this as docs/pm-tools-comparison.md?

You: yes, and also create a summary version for our team slack

Agent: ✓ Saved full report to docs/pm-tools-comparison.md

Here's the Slack summary:

📊 PM Tool Research Complete!

Quick take:
• Asana: Best for marketing/creative teams, easy UX
• Monday: Best automation, great visual workflows
• Jira: Best for dev teams, powerful but complex

Full report: docs/pm-tools-comparison.md

Recommendation: Monday.com for our cross-functional team
- Great automation (saves ~5hrs/week)
- Intuitive for non-technical users
- Good Slack/GitHub integration

Should I post this?
```

### Create Tutorial from Documentation

Turn external docs into custom tutorials.

````
You: Go to the Stripe API docs, learn about payment intents, and
     create a tutorial for our codebase

Agent: [Searches and reads Stripe documentation]

✓ Read Stripe Payment Intents documentation
✓ Analyzed our existing codebase structure
✓ Created tutorial adapted to our tech stack

Created: docs/stripe-payment-intents-guide.md

# Implementing Stripe Payment Intents

## Overview
Payment Intents API is Stripe's recommended way to handle payments.
It handles the complexity of different payment methods and 3D Secure.

## Our Implementation

Based on our existing code in `src/api/billing.ts`, here's how
to add Payment Intents:

### Step 1: Install Dependencies
```bash
npm install stripe @stripe/stripe-js
````

### Step 2: Create Payment Intent

```typescript
// src/api/stripe.ts
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function createPaymentIntent(amount: number, currency: string) {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amount * 100, // Convert to cents
    currency,
    automatic_payment_methods: { enabled: true },
  });

  return paymentIntent;
}
```

[... more detailed tutorial content]

## Testing

Use these test cards:

- Success: 4242 4242 4242 4242
- Requires Auth: 4000 0025 0000 3155

## Next Steps

1. Add webhook handling for payment confirmations
2. Implement idempotency keys
3. Add error handling for declined payments

---

Want me to also create example code files?

You: yes, create the complete implementation files

Agent: Creating implementation...

✓ Created src/api/stripe.ts (Payment Intent creation)
✓ Created src/api/webhooks.ts (Stripe webhook handling)
✓ Created tests/stripe.test.ts (Unit tests)
✓ Updated .env.example (Added Stripe keys)

All files ready! Should I commit these changes?

```

## 🔒 Security & Maintenance

### Security Audit

Find potential security issues in your codebase.

```

You: Scan the codebase for common security issues - hardcoded secrets,
SQL injection risks, XSS vulnerabilities

Agent: [Analyzes codebase]

🔒 Security Audit Report

**🔴 Critical Issues (2):**

1. Hardcoded API Key
   File: src/config/api.ts:12

   ```typescript
   const API_KEY = "sk_live_abc123..."; // ← Exposed secret!
   ```

   **Fix**: Move to environment variable

2. SQL Injection Risk  
   File: src/api/search.ts:45
   ```typescript
   db.query(`SELECT * FROM users WHERE name = '${userName}'`);
   ```
   **Fix**: Use parameterized queries

**🟡 Medium Issues (5):**

3. Missing Input Validation
   File: src/api/users.ts:78
   User input not sanitized before database insert

4. Weak Password Requirements
   File: src/auth/register.ts:23
   Only requires 6 characters, no complexity

[... more issues]

**✅ Good Practices Found:**

- Using HTTPS for all external requests
- JWT tokens have expiration
- CORS properly configured

Should I create a detailed report with fixes?

You: yes, and create GitHub issues for each critical item

Agent: ✓ Created docs/security-audit-2025-01.md

✓ Created GitHub Issues:

- Issue #142: [Security] Remove hardcoded API key from api.ts
- Issue #143: [Security] Fix SQL injection in search endpoint

Both labeled as "security" and "critical"

Would you like me to fix the critical issues now?

You: yes, fix both

Agent: [Applies fixes]

1. Fixed hardcoded API key:
   ✓ Moved to environment variable
   ✓ Updated .env.example
   ✓ Added config validation on startup

2. Fixed SQL injection:
   ✓ Converted to parameterized query
   ✓ Added input sanitization
   ✓ Added tests for malicious input

⚠️ Ready to commit these security fixes?

You: yes, commit with message "security: fix critical vulnerabilities"

Agent: ✓ Committed security fixes
Commit: def456

Recommendation: Force password reset for all users due to
previous SQL injection vulnerability.

Should I prepare a user notification email draft?

```

### Dependency Audit & Updates

Keep dependencies secure and up-to-date.

```

You: Check all npm dependencies for security vulnerabilities and
suggest updates

Agent: [Runs npm audit and checks versions]

📦 Dependency Audit Report

**🔴 Critical Vulnerabilities (2):**

1. lodash@4.17.20
   - CVE-2021-23337 (Command Injection)
   - Fix: Update to 4.17.21+
2. axios@0.21.1
   - CVE-2021-3749 (SSRF vulnerability)
   - Fix: Update to 0.21.4+

**🟡 Outdated Major Versions (8):**

- react: 17.0.2 → 18.2.0 (major update)
- typescript: 4.5.4 → 5.3.3 (major update)
  [... more]

**✅ Up to Date (145 packages)**

Should I update the vulnerable packages?

You: yes, update critical vulnerabilities and show me the react update path

Agent: [Updates critical packages]

✓ Updated lodash: 4.17.20 → 4.17.21
✓ Updated axios: 0.21.1 → 0.21.4
✓ Ran tests: All passing

For React 17 → 18 migration:
Breaking changes:

1. ReactDOM.render → createRoot
2. Removed IE support
3. New Strict Mode behaviors

Estimated effort: 2-3 hours
Risk level: Medium

Would you like me to:
a) Create a migration guide
b) Update React now  
c) Schedule for later

You: create a migration guide

Agent: ✓ Created docs/react-18-migration.md

The guide includes:

- Breaking changes checklist
- Step-by-step migration process
- Testing strategy
- Rollback plan

Saved for when you're ready to upgrade!

```

## 🎨 Content & Documentation

### Automated Changelog Generation

Create release notes from commit history.

```

You: Generate a changelog for all commits since the last tag

Agent: [Analyzes git history]

Last tag: v1.2.0 (30 days ago)
Found 47 commits since then

Organizing by type...

# Changelog v1.3.0

## 🚀 Features (12)

- Add user profile customization (#145)
- Implement dark mode toggle (#148)
- Add export to CSV functionality (#152)
- Support file attachments in comments (#156)
  [... more]

## 🐛 Bug Fixes (18)

- Fix memory leak in dashboard (#143)
- Resolve login redirect issue (#146)
- Correct timezone handling in reports (#151)
  [... more]

## 📚 Documentation (8)

- Update API documentation (#144)
- Add deployment guide (#149)
  [... more]

## 🔧 Maintenance (9)

- Update dependencies (#147)
- Improve test coverage (+15%)
  [... more]

Should I save this as CHANGELOG.md?

You: yes, and create a GitHub release draft

Agent: ✓ Updated CHANGELOG.md
✓ Created GitHub release draft v1.3.0

Release includes:

- Title: "Version 1.3.0 - Dark Mode & Profile Customization"
- Full changelog
- Links to all PRs
- Breaking changes highlighted

Ready to publish when you are!

```

## 🤖 Advanced Workflows

### Automated Code Review

Review pull requests before human reviewers.

```

You: Review PR #156 and provide feedback on code quality, tests, and docs

Agent: [Fetches PR #156 and analyzes changes]

📝 Code Review: PR #156 - "Add email notification system"

**📊 Overview:**

- Files changed: 8
- Lines added: 423
- Lines removed: 45
- Tests added: ✓ Yes

**✅ Strengths:**

1. Good test coverage (12 new tests)
2. Follows conventional commits
3. Updated documentation

**⚠️ Concerns:**

1. **Potential Memory Leak** (src/notifications/queue.ts:67)

   ```typescript
   const pendingNotifications = [];
   function addNotification(notification) {
     pendingNotifications.push(notification); // Never cleared!
   }
   ```

   Suggestion: Implement cleanup or max queue size

2. **Missing Error Handling** (src/notifications/send.ts:34)
   What happens if email service is down?
3. **Hard-coded Configuration** (src/notifications/config.ts:12)
   Email templates should be configurable

4. **Security**: Email addresses not validated before sending

**📚 Documentation:**

- ✓ README updated
- ✗ API docs missing
- ✗ No migration guide for existing users

**🧪 Testing:**

- ✓ Unit tests present
- ⚠️ Missing integration tests
- ⚠️ No email delivery tests

**Recommendation:**
Request changes - address memory leak and error handling before merge.

Should I post this as a review comment?

You: yes, post as request changes

Agent: ✓ Posted review on PR #156 with "Request Changes" status
✓ Added 4 inline comments on specific lines
✓ Mentioned maintainer in review

The author has been notified!

```

### Automated Deployment Workflow

Coordinate complex deployment processes.

```

You: Deploy the latest main branch to staging environment

Agent: Pre-deployment checks...

✓ All tests passing on main
✓ No pending migrations
✓ Latest commit: abc123 "feat: add notifications"

Starting staging deployment:

**Step 1: Build**
[Runs build command]
✓ Build successful (2m 34s)

**Step 2: Run Tests**  
✓ Unit tests: 234/234 passed
✓ Integration tests: 45/45 passed

**Step 3: Database Migrations**
Found 2 pending migrations:

1. 20250115_add_notifications_table.sql
2. 20250115_add_email_queue_table.sql

⚠️ About to apply migrations to staging database
Proceed? (yes/no)

You: yes

Agent: ✓ Applied migrations successfully

**Step 4: Deploy Application**
⚠️ About to deploy to staging:

- Environment: staging.app.company.com
- Version: v1.3.0-abc123
- Will cause ~30s downtime

Proceed? (yes/no)

You: yes

Agent: [Executes deployment]
✓ Uploaded assets to S3
✓ Updated container image
✓ Restarted application servers (3 instances)
✓ Health check passed

**Step 5: Smoke Tests**
✓ Homepage loads (201ms)
✓ API health endpoint: OK
✓ Database connectivity: OK
✓ Redis connectivity: OK

**Step 6: Notification**
Posting to #deployments Slack channel...

✓ Deployment Complete!

Summary:

- Version: v1.3.0
- Environment: staging
- Duration: 4m 12s
- Status: SUCCESS ✅

Staging URL: https://staging.app.company.com

Should I update the deployment log?

You: yes, and run a quick QA smoke test

Agent: ✓ Updated docs/deployments.md

Running QA smoke tests:
✓ User can log in
✓ Dashboard loads
✓ Can create new notification
✓ Email queue is processing
✓ All critical paths working

All systems operational! 🎉

````

---

## Tips for Creating Your Own Workflows

### 1. Start Simple

Begin with single-task agents and gradually combine them:

```bash
# Simple: Single purpose
jazz agent create --name "email-reader"

# Complex: Multi-purpose
jazz agent create --name "devops-assistant"
````

### 2. Use Descriptive Names

Good names help you remember what each agent does:

- ✅ `email-triage-bot`
- ✅ `git-cleanup-helper`
- ❌ `agent1`
- ❌ `bot`

### 3. Leverage Context

Agents remember conversation context:

```
You: Show me emails from Sarah
Agent: [Shows emails]

You: Reply to the latest one
Agent: [Knows you mean latest from Sarah]
```

### 4. Chain Operations

Ask agents to perform multi-step workflows:

```
You: Find all TODO comments, create GitHub issues for high-priority ones,
     and update the comments with issue numbers
```

### 5. Iterate and Improve

Refine your workflows based on results:

```
# First attempt
You: Clean up my inbox

# Better
You: Archive all newsletters from last month and label work emails by sender
```

## Need More Ideas?

Join our [Discord community](https://discord.gg/yBDbS2NZju) to:

- Share your workflows
- Get inspiration from others
- Request new features
- Contribute examples

Have a cool use case? Submit a PR to add it to this document!

---

**Remember**: Jazz agents work best when you give them clear instructions and review their suggestions before approving dangerous operations. Start simple and build up to more complex workflows as you get comfortable with the system.
