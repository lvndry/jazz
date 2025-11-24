# Jazz Use Cases

Real-world examples showcasing what you can accomplish with Jazz agents.

## Table of Contents

- [Email Management](#email-management)
  - [Smart Email Triage](#smart-email-triage)
  - [Bulk Email Cleanup](#bulk-email-cleanup)
- [Development Workflows](#development-workflows)
  - [Automated Project Onboarding](#automated-project-onboarding)
  - [Security Vulnerability Scanner & Auto-Fix](#security-vulnerability-scanner--auto-fix)
  - [Dependency Audit with Automated Updates](#dependency-audit-with-automated-updates)
  - [Automated Changelog & PR Descriptions](#automated-changelog--pr-descriptions)
- [Code Intelligence](#code-intelligence)
  - [Cross-Repository Refactoring](#cross-repository-refactoring)
  - [Technical Debt Tracker](#technical-debt-tracker)
- [DevOps & Deployment](#devops--deployment)
  - [Intelligent Deployment Pipeline](#intelligent-deployment-pipeline)
  - [Infrastructure Cost Optimizer](#infrastructure-cost-optimizer)
- [Research & Documentation](#research--documentation)
  - [API Integration Generator](#api-integration-generator)
  - [Competitive Analysis Report](#competitive-analysis-report)

---

## Email Management

### Smart Email Triage

Automate inbox management with intelligent categorization and prioritization.

```bash
jazz agent create
# Name: email-triage
# Tools: Gmail
```

**Example:**

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

### Bulk Email Cleanup

Clean up thousands of old emails based on age, sender, or content.

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

---

## Development Workflows

### Automated Project Onboarding

Clone a repository and automatically execute all setup instructions from the README.

```bash
jazz agent create
# Name: project-setup
# Tools: Git, Shell, File Management
```

**Example:**

```
You: Clone https://github.com/user/awesome-project and follow the README setup

Agent: ✓ Repository cloned to ./awesome-project

Found setup instructions:
1. Install dependencies: npm install
2. Copy .env.example to .env
3. Run database migrations: npm run migrate
4. Start dev server: npm run dev

Should I execute these steps?

You: yes, but ask before running migrations

Agent: [Executes steps 1-2]

✓ Dependencies installed (234 packages)
✓ Created .env from .env.example

⚠️ About to run: npm run migrate
This will modify your database.

Proceed? (yes/no)

You: yes

Agent: ✓ Migrations completed (applied 12 migrations)

✓ Setup complete! Ready to develop!
```

### Security Vulnerability Scanner & Auto-Fix

Scan codebase for security issues and automatically apply fixes.

```
You: Scan the codebase for security issues and fix critical ones

Agent: 🔒 Security Audit Report

🔴 Critical Issues (2):

1. Hardcoded API Key (src/config/api.ts:12)
   const API_KEY = "sk_live_abc123...";
   Fix: Move to environment variable

2. SQL Injection Risk (src/api/search.ts:45)
   db.query(`SELECT * FROM users WHERE name = '${userName}'`);
   Fix: Use parameterized queries

Should I fix these automatically?

You: yes

Agent: [Applies fixes]

✓ Moved API key to environment variable
✓ Converted to parameterized query
✓ Added input sanitization
✓ Added tests for malicious input

⚠️ Ready to commit security fixes?

You: yes

Agent: ✓ Committed: "security: fix critical vulnerabilities"
```

### Dependency Audit with Automated Updates

Check dependencies for vulnerabilities and update them safely.

```
You: Check npm dependencies for security vulnerabilities and update them

Agent: 📦 Dependency Audit Report

🔴 Critical Vulnerabilities (2):
1. lodash@4.17.20 - CVE-2021-23337 (Command Injection)
2. axios@0.21.1 - CVE-2021-3749 (SSRF vulnerability)

Should I update the vulnerable packages?

You: yes

Agent: ✓ Updated lodash: 4.17.20 → 4.17.21
✓ Updated axios: 0.21.1 → 0.21.4
✓ Ran tests: All passing

Security vulnerabilities resolved!
```

### Automated Changelog & PR Descriptions

Generate release notes from commit history and create detailed PR descriptions automatically.

```bash
jazz agent create
# Name: changelog-generator
# Tools: Git, File Management
```

**Example - Changelog Generation:**

```
You: Generate a changelog for all commits since the last tag

Agent: Last tag: v1.2.0 (30 days ago)
Found 47 commits since then

# Changelog v1.3.0

## 🚀 Features (12)
- Add user profile customization (#145)
- Implement dark mode toggle (#148)
- Add export to CSV functionality (#152)
- Support file attachments in comments (#156)

## 🐛 Bug Fixes (18)
- Fix memory leak in dashboard (#143)
- Resolve login redirect issue (#146)
- Correct timezone handling in reports (#151)

## 📚 Documentation (8)
- Update API documentation (#144)
- Add deployment guide (#149)

## 🔧 Maintenance (9)
- Update dependencies (#147)
- Improve test coverage (+15%)

Should I save this as CHANGELOG.md?

You: yes, and create a GitHub release draft

Agent: ✓ Updated CHANGELOG.md
✓ Created GitHub release draft v1.3.0

Release includes:
- Title: "Version 1.3.0 - Dark Mode & Profile Customization"
- Full changelog with PR links
- Breaking changes highlighted

Ready to publish!
```

**Example - PR Description:**

```
You: I'm about to create a PR. Generate a description from my changes

Agent: [Analyzes git diff and commits]

Found changes in:
- src/auth/jwt.ts (token refresh logic)
- src/middleware/auth.ts (new middleware)
- tests/auth.test.ts (12 new tests)

Generated PR description:

---
## Summary
Implements JWT token refresh mechanism to improve user experience and security.

## Changes
- ✨ Add automatic token refresh before expiration
- 🔒 Implement refresh token rotation for security
- 🧪 Add comprehensive test coverage (12 new tests)
- 📝 Update authentication documentation

## Technical Details
- Tokens now refresh 5 minutes before expiration
- Refresh tokens are single-use and rotate on each refresh
- Added Redis caching for refresh token blacklist
- Backward compatible with existing auth flow

## Testing
- All existing tests passing
- New tests cover refresh flow, rotation, and edge cases
- Manual testing completed on staging

## Breaking Changes
None - fully backward compatible

## Checklist
- [x] Tests added/updated
- [x] Documentation updated
- [x] No breaking changes
- [x] Tested locally
---

Copy this to your PR?

You: yes

Agent: ✓ Copied to clipboard
Ready to paste into GitHub!
```

---

## Code Intelligence

### Cross-Repository Refactoring

Refactor code patterns across multiple repositories simultaneously.

```bash
jazz agent create
# Name: refactor-master
# Tools: Git, File Management, Shell
```

**Example:**

```
You: Find all repositories in ~/projects that use the old Logger class
     and refactor them to use the new LoggerService

Agent: Scanning ~/projects...

Found old Logger usage in 5 repositories:
1. ~/projects/api-service (12 files)
2. ~/projects/web-app (8 files)
3. ~/projects/worker (5 files)
4. ~/projects/admin-panel (6 files)
5. ~/projects/mobile-backend (9 files)

Total: 40 files to refactor

Should I proceed with refactoring?

You: yes, show me the changes for one file first

Agent: Example refactoring (api-service/src/auth.ts):

- import { Logger } from './logger';
+ import { LoggerService } from '@company/logger';

- const logger = new Logger('auth');
+ const logger = LoggerService.create('auth');

- logger.log('User logged in');
+ logger.info('User logged in');

Apply this pattern to all 40 files?

You: yes

Agent: [Refactoring across repositories]

✓ api-service: 12 files updated
✓ web-app: 8 files updated
✓ worker: 5 files updated
✓ admin-panel: 6 files updated
✓ mobile-backend: 9 files updated

✓ All tests passing across all repositories
✓ Created commits in each repository

Summary:
- 40 files refactored
- 5 repositories updated
- 0 breaking changes
- All tests passing
```

### Technical Debt Tracker

Find, prioritize, and systematically address technical debt.

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

---

## DevOps & Deployment

### Intelligent Deployment Pipeline

Coordinate complex deployment with pre-checks, migrations, and smoke tests.

```
You: Deploy latest main to staging

Agent: Pre-deployment checks...

✓ All tests passing on main
✓ No pending migrations
✓ Latest commit: abc123 "feat: add notifications"

Starting staging deployment:

Step 1: Build
✓ Build successful (2m 34s)

Step 2: Database Migrations
Found 2 pending migrations.
⚠️ Apply migrations to staging database?

You: yes

Agent: ✓ Applied migrations successfully

Step 3: Deploy Application
⚠️ About to deploy to staging.app.company.com
Will cause ~30s downtime. Proceed?

You: yes

Agent: ✓ Uploaded assets to S3
✓ Updated container image
✓ Restarted application servers
✓ Health check passed

Step 4: Smoke Tests
✓ Homepage loads (201ms)
✓ API health: OK
✓ Database connectivity: OK

✓ Deployment Complete!
Duration: 4m 12s
```

### Infrastructure Cost Optimizer

Analyze cloud infrastructure usage and suggest cost optimizations.

```bash
jazz agent create
# Name: cost-optimizer
# Tools: Shell, File Management, Web Search
```

**Example:**

```
You: Analyze our AWS infrastructure and suggest cost optimizations

Agent: [Analyzing AWS resources via CLI]

💰 Cost Optimization Report

Current monthly spend: $12,450

🔴 High-Impact Savings (3):

1. Unused RDS Instances
   - 3 databases with 0 connections in last 30 days
   - Cost: $890/month
   - Recommendation: Delete or downsize
   - Savings: $890/month

2. Over-Provisioned EC2 Instances
   - 5 instances with <20% CPU utilization
   - Cost: $1,200/month
   - Recommendation: Downsize to smaller instance types
   - Savings: $600/month

3. Unattached EBS Volumes
   - 12 volumes not attached to any instance
   - Cost: $240/month
   - Recommendation: Delete after backup
   - Savings: $240/month

Total potential savings: $1,730/month (14% reduction)

Should I create a detailed action plan?

You: yes, and create Terraform changes for the EC2 downsizing

Agent: ✓ Created docs/cost-optimization-plan.md
✓ Generated Terraform changes for EC2 downsizing
✓ Estimated annual savings: $20,760

Review the changes and I can apply them when ready.
```

---

## Research & Documentation

### API Integration Generator

Research an API and generate complete integration code for your project.

```
You: Research the Stripe Payment Intents API and create a complete
     integration for our Node.js app

Agent: [Researching Stripe documentation]

✓ Read Stripe Payment Intents docs
✓ Analyzed our existing codebase structure
✓ Generated integration code

Created files:
✓ src/api/stripe.ts (Payment Intent creation)
✓ src/api/webhooks.ts (Stripe webhook handling)
✓ tests/stripe.test.ts (Unit tests)
✓ docs/stripe-integration.md (Tutorial)
✓ Updated .env.example (Added Stripe keys)

The integration includes:
- Payment Intent creation
- Webhook handling for confirmations
- Error handling for declined payments
- Test card numbers for development
- Idempotency key support

Should I commit these changes?
```

### Competitive Analysis Report

Research competitors and create comprehensive comparison reports.

```
You: Research the top 3 project management tools and create a
     comparison report with recommendations

Agent: [Researching Asana, Monday.com, and Jira]

✓ Gathered pricing information
✓ Compared features and integrations
✓ Analyzed user reviews
✓ Created comparison report

# Project Management Tools Comparison

## Feature Comparison

| Feature | Asana | Monday.com | Jira |
|---------|-------|------------|------|
| Task Management | ✓ | ✓ | ✓ |
| Agile Boards | Limited | ✓ | ✓✓ |
| Automation | ✓ | ✓✓ | ✓ |
| Integrations | 200+ | 50+ | 3000+ |

## Recommendation

Monday.com for our cross-functional team:
- Best automation (saves ~5hrs/week)
- Intuitive for non-technical users
- Good Slack/GitHub integration

Saved to: docs/pm-tools-comparison.md
```

---

## Tips for Creating Workflows

### Start Simple

Begin with single-task agents:

```bash
# Simple: Single purpose
jazz agent create --name "email-reader"

# Complex: Multi-purpose
jazz agent create --name "devops-assistant"
```

### Chain Operations

Ask agents to perform multi-step workflows:

```
You: Find all TODO comments, create GitHub issues for high-priority ones,
     and update the comments with issue numbers
```

### Iterate and Improve

Refine your workflows based on results:

```
# First attempt
You: Clean up my inbox

# Better
You: Archive all newsletters from last month and label work emails by sender
```

---

## Need More Ideas?

Join our [Discord community](https://discord.gg/yBDbS2NZju) to:

- Share your workflows
- Get inspiration from others
- Request new features
- Contribute examples

Have a cool use case? Submit a PR to add it to this document!

---

**Remember**: Jazz agents work best when you give them clear instructions and review their suggestions before approving dangerous operations.
