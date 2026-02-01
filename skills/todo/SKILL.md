---
name: todo
description: Create and track task lists for complex multi-step work. Use when planning projects, breaking down work, tracking progress, or when a task has 3+ steps. Triggers on "plan", "todo", "task list", "break down", "step by step", or complex requests requiring multiple actions.
---

# Todo Management

Create, track, and manage task lists for complex work. Essential for planning, progress tracking, and ensuring nothing is missed.

## When to Use Todos

**Always create todos when:**
- Task has 3+ distinct steps
- Work spans multiple files or systems
- User asks for a plan or breakdown
- Complex debugging or investigation
- Multi-phase projects (research → implement → test)
- Risk of forgetting steps mid-execution

**Skip todos for:**
- Single-step tasks
- Simple commands
- Quick lookups or reads

## Todo Format

Use markdown checkboxes for clear, trackable progress:

```markdown
## [Task Name]

### Phase 1: [Phase Name]
- [ ] Step 1: Description
- [ ] Step 2: Description
- [ ] Step 3: Description

### Phase 2: [Phase Name]
- [ ] Step 4: Description
- [ ] Step 5: Description
```

## Creating Effective Todos

### 1. Start with Decomposition

Break complex tasks into atomic, actionable items:

```markdown
## Deploy New Feature

### Analysis
- [ ] Review PR changes
- [ ] Check for breaking changes
- [ ] Verify test coverage

### Preparation
- [ ] Update dependencies
- [ ] Run full test suite
- [ ] Build production bundle

### Deployment
- [ ] Deploy to staging
- [ ] Run smoke tests
- [ ] Deploy to production
- [ ] Verify health checks

### Cleanup
- [ ] Update documentation
- [ ] Notify stakeholders
- [ ] Close related issues
```

### 2. Make Items Actionable

Each todo should be:
- **Specific**: Clear what needs to be done
- **Verifiable**: Know when it's complete
- **Independent**: Can be checked off alone (when possible)

| ❌ Vague | ✅ Actionable |
|----------|---------------|
| "Handle errors" | "Add try-catch to API calls in `api.ts`" |
| "Test it" | "Run `npm test` and verify 0 failures" |
| "Update config" | "Add `DEBUG=true` to `.env.local`" |

### 3. Order by Dependencies

Put prerequisite tasks first:

```markdown
## Setup Development Environment

- [ ] Install Node.js 20+ (`nvm install 20`)
- [ ] Clone repository (`git clone ...`)
- [ ] Install dependencies (`npm install`)  # Depends on Node.js
- [ ] Copy environment file (`cp .env.example .env`)
- [ ] Configure environment variables  # Depends on .env existing
- [ ] Start development server (`npm run dev`)  # Depends on all above
```

### 4. Group by Phase or Category

```markdown
## Refactor Authentication

### Backend Changes
- [ ] Extract auth logic to `auth-service.ts`
- [ ] Add JWT validation middleware
- [ ] Update user routes

### Frontend Changes
- [ ] Create AuthContext provider
- [ ] Add login/logout hooks
- [ ] Update protected routes

### Testing
- [ ] Add unit tests for auth service
- [ ] Add integration tests for auth flow
- [ ] Manual QA on staging
```

## Progress Tracking

### Update As You Go

Mark items complete immediately after finishing:

```markdown
- [x] Clone repository ✓
- [x] Install dependencies ✓
- [ ] Configure environment  ← Currently working on
- [ ] Start development server
```

### Add Notes When Relevant

```markdown
- [x] Run database migration
  - Note: Required manual fix for column type
- [ ] Verify data integrity
```

### Handle Blockers

```markdown
- [ ] ⚠️ BLOCKED: Deploy to production
  - Waiting on: Security review approval
  - Expected: Tomorrow EOD
```

## Todo Patterns

### Investigation/Debug Pattern

```markdown
## Debug: [Issue Description]

### Reproduce
- [ ] Get reproduction steps from user/ticket
- [ ] Reproduce locally
- [ ] Document exact error message

### Investigate
- [ ] Check logs for relevant errors
- [ ] Identify affected code paths
- [ ] Check recent changes (git log)

### Fix
- [ ] Implement fix
- [ ] Add test case
- [ ] Verify fix resolves issue

### Verify
- [ ] Test in development
- [ ] Test in staging
- [ ] Get user confirmation
```

### Feature Implementation Pattern

```markdown
## Feature: [Feature Name]

### Design
- [ ] Review requirements
- [ ] Design API/interface
- [ ] Get design approval

### Implement
- [ ] Create data models
- [ ] Implement business logic
- [ ] Build UI components
- [ ] Wire up integrations

### Test
- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual QA

### Ship
- [ ] Code review
- [ ] Deploy
- [ ] Monitor for issues
```

### Research Pattern

```markdown
## Research: [Topic]

### Gather
- [ ] Search for existing solutions
- [ ] Review documentation
- [ ] Find relevant examples

### Analyze
- [ ] Compare approaches
- [ ] List pros/cons
- [ ] Identify constraints

### Recommend
- [ ] Write summary
- [ ] Present recommendation
- [ ] Get decision
```

## Integration with Workflow

### At Task Start

1. Analyze the request
2. Create todo list with all steps
3. Share todo list with user
4. Begin execution

### During Execution

1. Work through items in order
2. Mark complete as you go
3. Add notes for important findings
4. Flag blockers immediately

### At Task End

1. Review all items are checked
2. Note any skipped items and why
3. Summarize what was accomplished

## Quick Reference

```markdown
## [Task Name]

- [ ] Pending item
- [x] Completed item
- [ ] ⚠️ BLOCKED: Item with blocker
- [ ] 🔄 IN PROGRESS: Currently working on
- [ ] ❌ SKIPPED: Item skipped (with reason)

### Notes
- Important finding or decision
```

## Anti-Patterns

- ❌ Todos that are too vague ("fix the bug")
- ❌ Giant todos with 50+ items (break into phases)
- ❌ Never updating progress
- ❌ Skipping todos for complex tasks
- ❌ Items that can't be independently verified
