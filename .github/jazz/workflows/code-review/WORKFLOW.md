---
name: code-review
description: Review pull request changes for quality, security, and correctness
autoApprove: true
agent: ci-reviewer
maxIterations: 100
skills:
  - code-review
---

# Pull Request Code Review

Review the changes in this pull request.

To get the diff, use the environment variables `PR_BASE_SHA` and `PR_HEAD_SHA`:

```
git diff $PR_BASE_SHA...$PR_HEAD_SHA
```

You can also scope to specific files:

```
git diff $PR_BASE_SHA...$PR_HEAD_SHA -- path/to/file.ts
```

Use the `code-review` skill for the full review checklist.

## Output Format

You MUST output ONLY a JSON array as the very last thing you write, wrapped in a ```json fenced code block.
Do NOT output anything after the JSON block.

Each element represents one review comment tied to a specific file and line(s):

````json
[
  {
    "path": "src/example.ts",
    "line": 42,
    "side": "RIGHT",
    "body": "**Critical**: This can throw if `user` is null.\n\nSuggestion:\n```ts\nif (!user) return;\n```"
  },
  {
    "path": "src/utils.ts",
    "line": 55,
    "start_line": 48,
    "side": "RIGHT",
    "body": "**Suggestion**: Consider extracting this block into a helper."
  }
]
````

Rules:

- `path`: relative file path from repo root (must exist in the diff)
- `line`: line number in the NEW version of the file (RIGHT side of the diff); end line for multi-line blocks
- `start_line`: (optional) start line for multi-line block comments; omit for single-line
- `side`: always "RIGHT" (comment on the new code)
- `body`: markdown comment — include severity (Critical/Suggestion/Nice-to-have), explanation, and a concrete fix when possible

If there are no issues, output an empty array: `[]`
