---
name: bugbot
description: Detect bugs and potential issues in pull request changes
autoApprove: true
agent: ci-bugbot
maxIterations: 100
skills:
  - code-review
---

# Bug Detection

Analyze the changes in this pull request using `git diff origin/main...HEAD`.

Hunt specifically for:

1. **Bugs** - Logic errors, off-by-one, race conditions, null dereferences
2. **Error handling gaps** - Uncaught exceptions, missing error paths, swallowed errors
3. **Security vulnerabilities** - Injection, auth bypass, secrets leakage, unsafe deserialization
4. **Regressions** - Changes that could break existing behavior or callers

## Output Format

You MUST output ONLY a JSON array as the very last thing you write, wrapped in a ```json fenced code block.
Do NOT output anything after the JSON block.

Each element represents one bug/issue tied to a specific file and line(s):

````json
[
  {
    "path": "src/example.ts",
    "line": 42,
    "side": "RIGHT",
    "body": "**Bug (Critical)**: Race condition — `counter` is read and written without synchronization.\n\nSuggestion:\n```ts\nawait mutex.acquire();\ntry { counter++; } finally { mutex.release(); }\n```"
  },
  {
    "path": "src/utils.ts",
    "line": 55,
    "start_line": 48,
    "side": "RIGHT",
    "body": "**Warning**: This block lacks error handling."
  }
]
````

Rules:

- `path`: relative file path from repo root (must exist in the diff)
- `line`: line number in the NEW version of the file (RIGHT side of the diff); end line for multi-line blocks
- `start_line`: (optional) start line for multi-line block comments; omit for single-line
- `side`: always "RIGHT"
- `body`: markdown — include severity (Critical/Warning/Info), what the bug is, why it matters, and a concrete fix

If no bugs are found, output an empty array `[]` and briefly explain what was checked.
