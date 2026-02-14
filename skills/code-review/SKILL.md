---
name: code-review
description: Review code for quality, security, and style using structured checklists. Use when reviewing PRs, giving feedback on code, or auditing code quality.
---

# Code Review

Review code against structured checklists for correctness, security, performance, and maintainability. Give actionable, prioritized feedback.

## When to Use

- User asks for a code review, PR review, or feedback on code
- User wants to check code quality, security, or style before merging
- User is auditing a file or module

## Workflow

1. **Understand context**: What is the change for? (issue, feature, refactor)
2. **Read the diff**: What actually changed?
3. **Run checklist**: Logic, security, performance, style, tests
4. **Consider language & framework best practices**: Does the code follow idiomatic patterns for the stack ?
5. **Prioritize**: Critical → must fix; Suggestion → consider; Nice-to-have → optional
6. **Respond**: Summary + categorized comments + concrete suggestions + what was done well

## Review Checklist

### Correctness & Logic
- [ ] Does it do what it claims? Edge cases?
- [ ] Off-by-one, null/undefined, empty inputs?
- [ ] Error handling: failures caught and handled?
- [ ] Concurrency: races, deadlocks, shared state?

### Security
- [ ] User input validated and sanitized?
- [ ] No secrets in code or logs?
- [ ] Auth/authz checked where needed?
- [ ] Dangerous functions (eval, exec, SQL concatenation) avoided?

### Performance
- [ ] Obvious inefficiency? (e.g. loop in loop when avoidable)
- [ ] Large data: streaming, pagination, or limits?
- [ ] Caching or repeated work that could be reused?

### Maintainability
- [ ] Naming clear? Functions do one thing?
- [ ] Duplication that could be factored?
- [ ] Magic numbers/strings that should be constants?
- [ ] Comments only where needed (why, not what)?

### Tests
- [ ] New behavior covered by tests?
- [ ] Tests readable and stable (no flake)?
- [ ] Mocks/fixtures appropriate?

### Style & Conventions
- [ ] Matches project style (lint, formatter)?
- [ ] Imports organized? Dead code removed?

## Feedback Format

Use a consistent severity and format:

```markdown
## Code Review: [PR/File name]

### Summary
[1-2 sentences: overall assessment and main concerns]

### Well done
- [Highlight specific things done very well—clear naming, solid error handling, idiomatic patterns, etc.]
- [Recognize good use of language/framework features.]

### Critical (must address)
- **[Location]** [Issue]. [Suggestion or fix.]
- ...

### Suggestions (consider)
- **[Location]** [Issue]. [Optional improvement.]
- ...

### Nice to have
- [Minor polish or future improvement.]
```

**Location**: file path, function name, or "line N" (if line numbers available). Be specific so the author can jump to it.

**Suggestion**: Prefer concrete fix (code snippet or exact change) over vague "consider improving X."

## Tone

- Respectful and constructive
- Assume good intent; explain the "why" behind requests
- Distinguish "this is wrong" vs "this could be clearer"
- No nitpicking without value; batch trivial style nits

## What Not to Do

- Don't skip the "Well done" section—acknowledging good work motivates and reinforces best practices
- Don't demand personal style preferences unless they're project convention
- Don't repeat what the diff already shows ("you added a function")
- Don't leave only "LGTM" without at least a one-line summary
- Don't mix severity: critical items must be clearly marked

## Small vs Large PRs

- **Small**: Full checklist, quick pass. One round of feedback.
- **Large**: Summarize by area (e.g. "Auth logic", "UI components"). Call out highest-risk areas first. Suggest splitting if it would help.

## Security-Sensitive Areas

Extra scrutiny for:
- Auth (login, sessions, permissions)
- Input handling (forms, API params, file upload)
- External calls (HTTP, DB, shell)
- Crypto and secrets

For these, explicitly note: "No issues found" or list concrete concerns.

## Anti-Patterns

- ❌ Vague feedback ("this could be better")
- ❌ Only praising without actionable items when issues exist
- ❌ Blocking on style nits that aren't in the style guide
- ❌ Missing the main bug or security issue while commenting on formatting
