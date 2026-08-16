# Dependency Security Audit

Automate security audits of your project dependencies and safely fix vulnerabilities.

## Example

**Ask:** `"Audit my dependencies for vulnerabilities and fix them"`

**Jazz will:**

1. Run security audit (`npm audit`, `poetry audit`, etc.)
2. Search CVE databases and changelogs for each vulnerability
3. Identify safe upgrade paths (major vs. patch versions)
4. Show you a summary with severity levels and fix options
5. Update `package.json`/`requirements.txt` with your approval
6. Run tests to verify nothing broke
7. Create a detailed commit message documenting the security fixes

## Setup

Create an agent with file system, shell, and git tools:

```bash
jazz agent create
# Name: security-auditor
# Tools: File System, Shell, Git, Web Search
```

## Usage

```bash
jazz agent chat security-auditor
```

Then ask Jazz to audit your dependencies. Jazz will:

- Detect your package manager (npm, yarn, pip, poetry, etc.)
- Run the appropriate audit command
- Research each vulnerability
- Propose fixes with your approval
- Run tests to ensure nothing broke
- Create a commit documenting the fixes

## More Examples

- `"Check for outdated dependencies and update them safely"`
- `"Audit only critical vulnerabilities"`
- `"Find and fix security issues in all my projects"`
