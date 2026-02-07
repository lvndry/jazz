---
name: skill-creator
description: Create new Jazz skills for automating workflows. Use when the user asks to create a skill, make a skill, or wants to define custom automation behavior.
---

# Skill Creator

Create effective Jazz skills for automating workflows and specialized tasks.

## Gathering Information (Questionnaire)

**Do not create the skill until you have enough information.** If the user's request is vague (e.g. "create a skill", "I want a skill for X") or missing any of the items below, guide them through a short questionnaire instead of guessing.

**You have enough info when you know:**

1. **Purpose**: What specific task or workflow should this skill automate?
2. **Location**: Global (`~/.jazz/skills/`) or project-specific (`./skills/`)?
3. **Triggers**: When should Jazz automatically apply this skill? (Trigger phrases or scenarios.)
4. **Domain knowledge**: What specialized information is needed?
5. **Output format**: Are there specific templates or formats required?

**How to run the questionnaire:**

- Ask **one or a few questions at a time**; don't dump a long list.
- If the user gave partial context, infer what you can and ask only for what's missing.
- After each answer, confirm what you have and ask only what's still missing.
- Once you have all five items above, proceed to create the skill (directory + SKILL.md and any supporting files).

## Skill Structure

```
skill-name/
├── SKILL.md              # Required - main instructions
├── reference.md          # Optional - detailed documentation
├── examples.md           # Optional - usage examples
└── scripts/              # Optional - utility scripts
```

### Storage Locations

| Type     | Path                         | Scope                     |
| -------- | ---------------------------- | ------------------------- |
| Global   | `~/.jazz/skills/skill-name/` | Available in all projects |
| Project  | `./skills/skill-name/`       | Project-specific          |
| Built-in | Ships with Jazz              | Cannot be modified        |

## SKILL.md Format

Every skill requires a `SKILL.md` with YAML frontmatter:

```markdown
---
name: your-skill-name
description: Brief description of what this skill does and when to use it
---

# Your Skill Name

## Instructions

Clear, step-by-step guidance.

## Examples

Concrete usage examples.
```

### Required Metadata

| Field         | Requirements                                    | Purpose                               |
| ------------- | ----------------------------------------------- | ------------------------------------- |
| `name`        | Max 64 chars, lowercase letters/numbers/hyphens | Unique identifier                     |
| `description` | Max 1024 chars                                  | Helps Jazz decide when to apply skill |

## Writing Descriptions

The description determines when Jazz applies the skill.

### Best Practices

1. **Write in third person**:
   - ✅ "Processes data files and generates reports"
   - ❌ "I can help you process files"

2. **Be specific with trigger terms**:
   - ✅ "Generate release notes from git commits. Use when releasing, creating changelogs, or preparing release documentation."
   - ❌ "Helps with releases"

3. **Include WHAT and WHEN**:
   - WHAT: The skill's capabilities
   - WHEN: Trigger scenarios

## Authoring Principles

### 1. Be Concise

Context window is shared. Only add information Jazz doesn't already know.

**Good:**

```markdown
## Generate report

Use pandas for data analysis:
\`\`\`python
import pandas as pd
df = pd.read_csv("data.csv")
\`\`\`
```

**Bad:**

```markdown
## Generate report

Data analysis is important for understanding patterns.
There are many ways to analyze data, but we recommend...
```

### 2. Keep SKILL.md Under 500 Lines

Use progressive disclosure for detailed content.

### 3. Progressive Disclosure

Essential info in SKILL.md; details in separate files:

```markdown
## Additional resources

- For API details, see [reference.md](reference.md)
- For examples, see [examples.md](examples.md)
```

### 4. Appropriate Detail Level

| Freedom           | When                      | Example                |
| ----------------- | ------------------------- | ---------------------- |
| High (text)       | Multiple valid approaches | Code review guidelines |
| Medium (template) | Preferred pattern         | Report generation      |
| Low (script)      | Consistency critical      | Database migrations    |

### 5. Time-Aware Content (when relevant)

If the skill deals with news, research, or time-sensitive information:

- **Respect user time frame** when given (e.g. "this week", "2024", "last 5 years").
- **Default to most recent** when no time frame is given (don't assume "all time").
- State the time scope in the output (e.g. "Digest — This week" or "As of 2024...").

## Common Patterns

### Template Pattern

```markdown
## Report structure

\`\`\`markdown

# [Title]

## Summary

[Overview]

## Findings

- Finding 1
- Finding 2

## Recommendations

1. Action 1
2. Action 2
   \`\`\`
```

### Workflow Pattern

```markdown
## Workflow

- [ ] Step 1: Analyze input
- [ ] Step 2: Process data
- [ ] Step 3: Generate output
- [ ] Step 4: Validate results

**Step 1: Analyze input**
Run: `python scripts/analyze.py input.json`
```

### Conditional Pattern

```markdown
## Choose workflow

**Creating new?** → Follow "Creation" section
**Editing existing?** → Follow "Edit" section
```

## Creation Workflow

### Phase 1: Discovery (questionnaire if needed)

Gather purpose, location, triggers, requirements, examples. If the user hasn't provided all of these, guide them through questions until you have enough info—then proceed to Phase 2.

### Phase 2: Design

1. Draft skill name (lowercase, hyphens, max 64 chars)
2. Write specific description
3. Outline main sections
4. Identify supporting files needed

### Phase 3: Implementation

1. Create directory structure
2. Write SKILL.md with frontmatter
3. Create supporting files
4. Add utility scripts if needed

### Phase 4: Verification

- [ ] SKILL.md under 500 lines
- [ ] Description is specific with trigger terms
- [ ] Consistent terminology
- [ ] References one level deep
- [ ] Can be discovered and loaded

## Anti-Patterns

- ❌ Windows paths (`scripts\helper.py`)
- ❌ Too many options without defaults
- ❌ Time-sensitive information
- ❌ Inconsistent terminology
- ❌ Vague names (`helper`, `utils`)

## Additional Resources

- For output formatting patterns, see [references/output-patterns.md](references/output-patterns.md)

## Complete Example

**Directory:**

```
code-review/
├── SKILL.md
└── standards.md
```

**SKILL.md:**

```markdown
---
name: code-review
description: Review code for quality and security. Use when reviewing PRs or code changes.
---

# Code Review

## Checklist

- [ ] Logic correct, handles edge cases
- [ ] No security vulnerabilities
- [ ] Follows style conventions
- [ ] Tests cover changes

## Feedback Format

- 🔴 **Critical**: Must fix
- 🟡 **Suggestion**: Consider improving
- 🟢 **Nice to have**: Optional

## Details

See [standards.md](standards.md) for coding standards.
```
