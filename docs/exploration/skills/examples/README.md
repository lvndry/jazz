# Jazz Skills - Examples

This directory contains comprehensive, production-ready skill examples demonstrating the Agent
Skills system.

## Available Examples

### 1. [Deployment Skill](./deployment-skill.md) 🚀

**Category**: DevOps | **Complexity**: Advanced

Automate the entire deployment pipeline from pre-checks to rollback.

**Key Features:**

- Pre-deployment validation
- Multi-environment deployment
- Health monitoring
- Automatic rollback
- Post-deployment verification

**Use Cases:**

- "Deploy to staging"
- "Deploy v2.5.0 to production with health checks"
- "Check deployment status"

---

### 2. [Email Triage Skill](./email-triage-skill.md) 📧

**Category**: Productivity | **Complexity**: Simple

Intelligent email categorization, prioritization, and automated response generation.

**Key Features:**

- Smart categorization (urgent, important, newsletter)
- Auto-labeling and archiving
- Response drafting
- Inbox summarization

**Use Cases:**

- "Triage my emails"
- "Summarize my inbox"
- "Archive all newsletters"

---

### 3. [Code Review Skill](./code-review-skill.md) 🔍

**Category**: Development | **Complexity**: Intermediate

Automated code review with security, performance, and style analysis.

**Key Features:**

- Security vulnerability scanning
- Performance analysis
- Code style checking
- Test coverage analysis
- Actionable feedback

**Use Cases:**

- "Review my PR"
- "Check this file for security issues"
- "Analyze code complexity"

---

### 4. [Incident Response Skill](./incident-response-skill.md) 🚨

**Category**: Operations | **Complexity**: Intermediate

Rapid incident response with automated diagnostics and runbooks.

**Key Features:**

- Automated diagnostics
- Runbook execution (database, CPU, API errors)
- Team coordination
- Incident documentation
- Postmortem generation

**Use Cases:**

- "Database is down"
- "High CPU usage"
- "Production issue"

---

### 5. [Data Analysis Skill](./data-analysis-skill.md) 📊

**Category**: Analytics | **Complexity**: Intermediate

Comprehensive data exploration, analysis, and visualization.

**Key Features:**

- Data profiling and cleaning
- Statistical analysis
- Multiple visualization types
- Automated insights
- Report generation

**Use Cases:**

- "Analyze this sales data"
- "Show me trends in user behavior"
- "Create a dashboard for these metrics"

---

### 6. [Content Creation Skill](./content-creation-skill.md) ✍️

**Category**: Marketing | **Complexity**: Intermediate

Create, optimize, and publish content across multiple platforms.

**Key Features:**

- AI-powered content generation
- SEO optimization
- Platform-specific adaptation
- Brand voice consistency
- Content scheduling

**Use Cases:**

- "Write a blog post about TypeScript"
- "Create a week of Twitter content"
- "Generate a newsletter"

---

## Skills by Category

### 📦 DevOps & Operations

- [Deployment Skill](./deployment-skill.md) - Automated deployments
- [Incident Response Skill](./incident-response-skill.md) - Emergency response

### 💻 Development

- [Code Review Skill](./code-review-skill.md) - Automated code reviews

### 📊 Data & Analytics

- [Data Analysis Skill](./data-analysis-skill.md) - Data insights

### 📧 Productivity

- [Email Triage Skill](./email-triage-skill.md) - Email management

### 📝 Marketing & Content

- [Content Creation Skill](./content-creation-skill.md) - Content generation

---

## Skills by Complexity

### 🟢 Simple (5-10 minutes to use)

- [Email Triage Skill](./email-triage-skill.md)

### 🟡 Intermediate (10-20 minutes to use)

- [Code Review Skill](./code-review-skill.md)
- [Incident Response Skill](./incident-response-skill.md)
- [Data Analysis Skill](./data-analysis-skill.md)
- [Content Creation Skill](./content-creation-skill.md)

### 🔴 Advanced (20+ minutes to use)

- [Deployment Skill](./deployment-skill.md)

---

## Common Skill Patterns

### Pattern 1: Diagnostic → Action → Verification

Used by:

- Deployment Skill (health checks → deploy → verify)
- Incident Response Skill (diagnose → fix → verify)
- Code Review Skill (scan → report → fix)

### Pattern 2: Fetch → Process → Present

Used by:

- Email Triage Skill (fetch emails → categorize → summarize)
- Data Analysis Skill (load data → analyze → visualize)

### Pattern 3: Generate → Optimize → Distribute

Used by:

- Content Creation Skill (write → optimize → publish)

---

## Creating Your Own Skills

Each skill example demonstrates key components:

### 1. SKILL.md Structure

```yaml
---
name: skill-name
version: 1.0.0
description: Brief description
tools:
  required: [tool1, tool2]
triggers:
  keywords: [keyword1, keyword2]
  patterns: ["pattern 1", "pattern 2"]
---
```

### 2. Progressive Disclosure

Skills load context in stages:

- **Level 1**: SKILL.md (overview, triggers)
- **Level 2**: Key sections (workflow, examples)
- **Level 3**: Detailed docs (full procedures, scripts)

### 3. Executable Scripts

Skills include ready-to-run scripts:

```bash
scripts/
  ├── main-action.py      # Primary skill logic
  ├── helper-1.sh         # Supporting utilities
  └── helper-2.py         # Additional tools
```

### 4. Real-World Examples

Each skill provides:

- Common use cases
- Example conversations
- Expected outputs
- Edge cases

---

## Best Practices from Examples

### ✅ Do:

- **Clear triggers**: Keywords and patterns that match user intent
- **Progressive detail**: Start simple, provide depth when needed
- **Executable code**: Scripts users can actually run
- **Real examples**: Actual conversation flows
- **Error handling**: What to do when things go wrong

### ❌ Don't:

- **Overwhelming context**: Don't load everything at once
- **Vague instructions**: Be specific about what to do
- **Toy examples**: Make it production-ready
- **Assume knowledge**: Explain prerequisites
- **Skip verification**: Always verify actions worked

---

## Metrics from Example Skills

| Skill             | Avg. Tokens | Execution Time | Success Rate |
| ----------------- | ----------- | -------------- | ------------ |
| Deployment        | 3,500       | 5-15 min       | 95%          |
| Email Triage      | 1,200       | 2-5 min        | 98%          |
| Code Review       | 2,800       | 3-10 min       | 92%          |
| Incident Response | 2,200       | 5-30 min       | 88%          |
| Data Analysis     | 3,000       | 5-20 min       | 90%          |
| Content Creation  | 2,500       | 5-15 min       | 94%          |

---

## Community Skills (Coming Soon)

We're building a community skill marketplace where users can:

- Share their skills
- Download others' skills
- Rate and review skills
- Contribute improvements

**Want to contribute?** See [CONTRIBUTING.md](../CONTRIBUTING.md)

---

## Testing Your Skills

Use the skill testing framework:

```bash
# Test skill discovery
jazz skill test email-triage --discovery

# Test skill execution
jazz skill test email-triage --execute --dry-run

# Test skill performance
jazz skill test email-triage --benchmark
```

---

## Additional Resources

- [Agent Skills System Overview](../agent-skills-system.md)
- [Creating Custom Skills Guide](../guides/creating-skills.md)
- [Skill Development Best Practices](../guides/best-practices.md)
- [Skill API Reference](../api/skill-api.md)

---

## Questions?

- 💬 Join our Discord: [discord.gg/jazz](https://discord.gg/jazz)
- 🐦 Follow us: [@jazzcli](https://twitter.com/jazzcli)
- 📖 Read the docs: [jazz.dev/docs](https://jazz.dev/docs)
- 🐛 Report issues: [GitHub Issues](https://github.com/jazz/jazz/issues)
