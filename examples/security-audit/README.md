# Security Vulnerability Scanner & Auto-Fix

Scan codebase for security issues and automatically apply fixes.

## Example

**Ask:** `"Scan the codebase for security issues and fix critical ones"`

**Jazz will:**

1. Scan the codebase for common security vulnerabilities
2. Identify issues like hardcoded secrets, SQL injection risks, XSS vulnerabilities
3. Show you a detailed report with severity levels
4. Propose fixes for each issue
5. Apply fixes with your approval
6. Run tests to verify nothing broke

## Setup

Create an agent with file system, shell, and git tools:

```bash
jazz agent create
# Name: security-auditor
# Tools: File System, Shell, Git
```

## Usage

```bash
jazz agent chat security-auditor
```

Then ask Jazz to scan for security issues. Jazz will:

- Analyze your codebase for security vulnerabilities
- Categorize issues by severity
- Show you the problematic code
- Propose fixes
- Apply fixes with your approval
- Run tests to verify

## Example Output

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

## More Examples

- `"Find all hardcoded secrets in the codebase"`
- `"Check for SQL injection vulnerabilities"`
- `"Scan for XSS and CSRF vulnerabilities"`
- `"Audit authentication and authorization code"`

## Tips

- Jazz identifies common security patterns and anti-patterns
- All fixes require your approval before applying
- Tests are run after fixes to ensure nothing broke
- Jazz can commit fixes automatically with descriptive messages



