# Example: Code Review Skill

A comprehensive skill for automated code review following best practices and security guidelines.

## Directory Structure

```
skills/code-review/
├── SKILL.md
├── security-checklist.md
├── performance-guidelines.md
├── style-guide.md
├── scripts/
│   ├── static-analysis.sh
│   ├── security-scan.sh
│   ├── complexity-check.py
│   └── test-coverage.sh
└── configs/
    ├── eslint.json
    ├── sonar-rules.json
    └── review-checklist.json
```

## SKILL.md

````yaml
---
name: code-review
version: 2.0.0
description: Automated code review with security, performance, and style analysis
author: Engineering Team
tags: [development, code-quality, security, review, automation]
category: Development
complexity: intermediate

tools:
  required:
    - read_file
    - list_dir
    - execute_command
    - git_diff
    - git_status
  optional:
    - git_log
    - http_request
    - write_file

triggers:
  keywords:
    - review
    - code review
    - pr
    - pull request
    - check code
    - analyze
  patterns:
    - "review (this|the|my) (code|pr|pull request)"
    - "check (this|the) (code|pr)"
    - "analyze (this|the) code"
    - "review changes"
  context_hints:
    - current_directory_contains: [".git/", "package.json", "pom.xml", "Cargo.toml"]
    - git_repository: true

risk_level: low
approval_required: false

sections:
  - security-checklist.md
  - performance-guidelines.md
  - style-guide.md

estimated_duration: 3-10 minutes
prerequisites:
  - Git repository
  - Code linters installed (optional)
  - Test suite (optional)

last_updated: 2024-01-15
---

# Code Review Skill

Perform comprehensive, automated code reviews following industry best practices.

## Overview

Code reviews are essential for maintaining quality, but they're time-consuming. This skill automates
the mechanical aspects of code review, catching common issues and allowing human reviewers to focus
on architectural and business logic concerns.

## Core Capabilities

1. **Security Analysis**
   - SQL injection vulnerabilities
   - XSS vulnerabilities
   - Hardcoded secrets/credentials
   - Insecure dependencies
   - OWASP Top 10 checks

2. **Performance Review**
   - Algorithmic complexity
   - Database query patterns
   - Memory leaks
   - Inefficient loops
   - Resource management

3. **Code Style**
   - Linting violations
   - Naming conventions
   - Code formatting
   - Comment quality
   - Documentation completeness

4. **Testing**
   - Test coverage
   - Missing test cases
   - Test quality
   - Edge case handling

5. **Best Practices**
   - SOLID principles
   - DRY violations
   - Error handling
   - Logging practices
   - Dependency management

## Basic Workflow

When user requests code review:

### Step 1: Identify Changes

```typescript
// Get diff of changes
const diff = await executeTool("git_diff", {
  target: "HEAD",
  base: "main",
});

// Or review specific files
const files = await executeTool("list_dir", {
  path: "./src",
  pattern: "*.{ts,js,py}",
});
````

### Step 2: Run Static Analysis

Execute analysis tools:

```bash
# Run all checks
./scripts/static-analysis.sh

# This runs:
# - ESLint/Pylint for style
# - SonarQube for code smells
# - Semgrep for security
# - Complexity analysis
```

### Step 3: Security Scan

```bash
./scripts/security-scan.sh

# Checks:
# - npm audit / pip-audit
# - Secrets detection (gitleaks)
# - SAST analysis
# - Dependency vulnerabilities
```

### Step 4: Test Coverage

```bash
./scripts/test-coverage.sh

# Analyzes:
# - Overall coverage %
# - Uncovered critical paths
# - Missing edge cases
# - Test quality
```

### Step 5: Generate Review Report

Synthesize findings into actionable feedback:

```
🔍 Code Review Summary

📊 Overview:
  • 15 files changed
  • +450 -120 lines
  • 3 issues found

🔴 Critical (1):
  ❌ SQL Injection vulnerability in user/repository.ts:45
     → Use parameterized queries

🟡 Warnings (2):
  ⚠️ High complexity (cyclomatic: 15) in auth/service.ts:120
     → Consider refactoring into smaller functions

  ⚠️ Test coverage dropped from 85% to 78%
     → Add tests for new UserService methods

✅ Positive Notes:
  • Good error handling in API endpoints
  • Well-documented public interfaces
  • No dependency vulnerabilities

📝 Detailed Findings Below...
```

## Security Checklist

### Critical Security Issues

Always check for:

1. **SQL Injection**

   ```typescript
   // ❌ Bad
   db.query(`SELECT * FROM users WHERE id = ${userId}`);

   // ✅ Good
   db.query("SELECT * FROM users WHERE id = ?", [userId]);
   ```

2. **XSS Vulnerabilities**

   ```javascript
   // ❌ Bad
   element.innerHTML = userInput;

   // ✅ Good
   element.textContent = userInput;
   ```

3. **Hardcoded Secrets**

   ```typescript
   // ❌ Bad
   const API_KEY = "sk_live_abc123...";

   // ✅ Good
   const API_KEY = process.env.API_KEY;
   ```

4. **Insecure Authentication**

   ```typescript
   // ❌ Bad
   if (password === user.password) { ... }

   // ✅ Good
   if (await bcrypt.compare(password, user.hashedPassword)) { ... }
   ```

See [security-checklist.md](security-checklist.md) for comprehensive list.

## Performance Guidelines

### Common Performance Issues

1. **N+1 Queries**

   ```typescript
   // ❌ Bad - N+1 queries
   for (const user of users) {
     user.posts = await db.query("SELECT * FROM posts WHERE user_id = ?", [user.id]);
   }

   // ✅ Good - Single query with join
   const usersWithPosts = await db.query(`
     SELECT u.*, p.* FROM users u
     LEFT JOIN posts p ON p.user_id = u.id
   `);
   ```

2. **Inefficient Loops**

   ```typescript
   // ❌ Bad - O(n²)
   const duplicates = items.filter((item, i) => items.indexOf(item) !== i);

   // ✅ Good - O(n)
   const seen = new Set();
   const duplicates = items.filter((item) => {
     if (seen.has(item)) return true;
     seen.add(item);
     return false;
   });
   ```

3. **Memory Leaks**

   ```typescript
   // ❌ Bad - Leaked listeners
   element.addEventListener("click", handler);

   // ✅ Good - Cleanup
   element.addEventListener("click", handler);
   // Later:
   element.removeEventListener("click", handler);
   ```

See [performance-guidelines.md](performance-guidelines.md) for details.

## Code Style Standards

### Naming Conventions

- **Classes**: PascalCase - `UserService`, `PaymentController`
- **Functions**: camelCase - `getUserById`, `processPayment`
- **Constants**: UPPER_SNAKE_CASE - `MAX_RETRIES`, `API_URL`
- **Files**: kebab-case - `user-service.ts`, `payment-controller.ts`

### Function Size

- **Maximum lines**: 50 lines per function
- **Maximum complexity**: Cyclomatic complexity < 10
- **Maximum parameters**: 4 parameters

### Documentation

Required for:

- All public APIs
- Complex algorithms
- Non-obvious business logic
- Security-sensitive code

```typescript
/**
 * Process a payment transaction
 *
 * @param userId - The user making the payment
 * @param amount - Payment amount in cents
 * @param currency - ISO 4217 currency code
 * @returns Payment confirmation or throws PaymentError
 * @throws {PaymentError} If payment processing fails
 * @throws {ValidationError} If parameters are invalid
 */
async function processPayment(
  userId: string,
  amount: number,
  currency: string,
): Promise<PaymentConfirmation> {
  // Implementation
}
```

See [style-guide.md](style-guide.md) for complete guide.

## Code Resources

### scripts/static-analysis.sh

Run static code analysis tools.

**Usage:**

```bash
./scripts/static-analysis.sh [--strict] [--fix]

Options:
  --strict    Fail on warnings
  --fix       Auto-fix issues where possible
```

Runs:

- ESLint (JavaScript/TypeScript)
- Pylint (Python)
- RuboCop (Ruby)
- Clippy (Rust)

### scripts/security-scan.sh

Security vulnerability scanning.

**Usage:**

```bash
./scripts/security-scan.sh [--report-only]

Options:
  --report-only    Generate report without failing
```

Checks:

- Dependency vulnerabilities
- Hardcoded secrets
- OWASP Top 10
- CWE patterns

### scripts/complexity-check.py

Analyze code complexity.

**Usage:**

```bash
python scripts/complexity-check.py --path ./src --threshold 10
```

Measures:

- Cyclomatic complexity
- Cognitive complexity
- Lines of code
- Function length

### scripts/test-coverage.sh

Test coverage analysis.

**Usage:**

```bash
./scripts/test-coverage.sh --min-coverage 80
```

## Review Checklist

### Automated Checks

- [ ] All tests pass
- [ ] Code coverage >= 80%
- [ ] No linting errors
- [ ] No security vulnerabilities
- [ ] No hardcoded secrets
- [ ] Complexity < threshold
- [ ] Dependencies up to date
- [ ] Documentation complete

### Manual Review Needed

- [ ] Business logic correct
- [ ] Error handling appropriate
- [ ] API design sensible
- [ ] Database schema sound
- [ ] Performance acceptable
- [ ] User experience good

## Example Usage

### Example 1: PR Review

````
User: "Review my PR"

Agent: [Loads code-review skill]
Agent: [Gets git diff]
Agent: "Reviewing 8 changed files..."
Agent: [Runs static analysis]
Agent: [Runs security scan]
Agent: [Checks test coverage]

Agent: "📋 Code Review Complete!

🔍 Files Reviewed: 8
📊 Lines Changed: +320 -45

🔴 Issues Found:

1. CRITICAL - auth/login.ts:45
   Security: Passwords logged in plain text
   ```typescript
   logger.info(\`Login attempt for ${email} with password ${password}\`)
````

→ Remove password from logs

2. HIGH - database/queries.ts:78 SQL Injection risk

   ```typescript
   db.query(\`SELECT * FROM users WHERE name = '${userName}'\`)
   ```

   → Use parameterized queries

3. MEDIUM - api/users.ts:120 High complexity (cyclomatic: 15) → Refactor getUserWithPermissions()

🟡 Warnings:

• Test coverage: 78% (target: 80%) Missing tests for:

- api/users.ts:150-180
- auth/permissions.ts:45-60

• Performance: N+1 query in users/service.ts:200

✅ Good Practices:

• Excellent error handling in API layer • Well-structured async/await usage • Good separation of
concerns

📝 Recommendations:

1. Fix critical security issues before merging
2. Add tests for new user permissions
3. Consider caching user permissions
4. Update documentation for new API endpoints

Overall: 🟡 Needs work before merging"

```

### Example 2: Quick Security Check

```

User: "Check this file for security issues"

Agent: [Loads code-review skill] Agent: [Loads security-checklist.md] Agent: [Scans file]

Agent: "🔐 Security Scan Results:

File: payment/processor.ts

❌ Found 2 security issues:

1. Line 45: Hardcoded API key const STRIPE*KEY = "sk_live*..."; → Move to environment variable

2. Line 120: Unvalidated user input const amount = req.body.amount; → Add input validation

✅ No SQL injection risks ✅ No XSS vulnerabilities ✅ Proper error handling

Recommendation: Fix 2 issues before production"

```

### Example 3: Style Check

```

User: "Check code style"

Agent: [Loads code-review skill] Agent: [Runs linter]

Agent: "📝 Style Check Results:

✅ Overall: 95% compliant

Issues found (12):

Naming: • Variable 'user_data' should be camelCase (userData) • Function 'Process_Payment' should be
camelCase

Formatting: • Missing semicolons (6 locations) • Inconsistent indentation (2 locations)

Documentation: • Missing JSDoc for public function 'exportData'

Run with --fix to auto-correct 10/12 issues"

````

## Best Practices

1. **Review early and often**
   - Small, frequent reviews
   - Catch issues before they compound

2. **Automate the mechanical**
   - Let tools catch style/syntax
   - Focus human review on logic

3. **Prioritize security**
   - Always check critical paths
   - Never skip security scans

4. **Maintain standards**
   - Keep style guide updated
   - Enforce coverage thresholds

5. **Provide context**
   - Link to relevant documentation
   - Explain *why*, not just *what*

## Configuration

Customize review criteria in `configs/review-checklist.json`:

```json
{
  "thresholds": {
    "test_coverage_min": 80,
    "complexity_max": 10,
    "function_length_max": 50,
    "file_length_max": 300
  },
  "style": {
    "naming": "camelCase",
    "indent": "2spaces",
    "quotes": "single"
  },
  "security": {
    "block_hardcoded_secrets": true,
    "require_parameterized_queries": true,
    "enforce_https": true
  },
  "performance": {
    "flag_n_plus_one": true,
    "warn_nested_loops": true,
    "check_algorithm_complexity": true
  }
}
````

## Related Skills

Works well with:

- **git-workflows**: For commit and branch management
- **deployment**: Ensure quality before deploy
- **testing**: Run comprehensive test suites

## Changelog

### v2.0.0 (2024-01-15)

- Added AI-powered code smell detection
- Improved security scanning
- Performance analysis
- Custom rule support

### v1.5.0 (2023-12-01)

- Multi-language support
- Test coverage analysis
- Automated fixes

### v1.0.0 (2023-10-01)

- Initial release
- Basic linting
- Security scanning

```

---

This code review skill demonstrates:
- ✅ Multi-layered analysis (security, performance, style)
- ✅ Automated scanning with multiple tools
- ✅ Actionable feedback with examples
- ✅ Configurable standards
- ✅ Comprehensive checklists

```
