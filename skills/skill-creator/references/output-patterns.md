# Output Patterns and Templates for Skills

This file provides reusable patterns for structuring the outputs of skills
created with the `create-skill` meta-skill.

## Checklist-Style Output

Use when the skill needs to report on validation or review results.

```markdown
# Result Summary

- [ ] Requirement 1 satisfied? Explanation…
- [ ] Requirement 2 satisfied? Explanation…
- [ ] Requirement 3 satisfied? Explanation…

## Details

[Provide detailed notes, findings, or links here.]
```

## Structured Report Output

Use when the skill generates reports, docs, or analyses.

```markdown
# Title of Report

## Overview

[Short description of what this report covers.]

## Findings

1. [Finding 1]
2. [Finding 2]
3. [Finding 3]

## Recommendations

- [Recommendation 1]
- [Recommendation 2]

## Next Steps

[List concrete follow-up actions or prompts the user can run.]
```

## Diff or Change Log Output

Use when the skill modifies files or proposes changes.

```markdown
# Changes Made

## Summary

[High-level description of what changed and why.]

## File-by-File

- `path/to/file1` – [Description of changes]
- `path/to/file2` – [Description of changes]

## Potential Risks

- [Risk 1]
- [Risk 2]

## How to Revert

[Instructions or pointers for undoing changes, if applicable.]
```
