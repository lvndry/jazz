# Analyze Git History and Squash Commits

Clean up your git history by analyzing commits and intelligently squashing related or useless commits together.

## Example

**Ask:** `"Analyze my git history and help me squash useless commits"`

**Jazz will:**

1. Analyze recent git commit history
2. Identify commits that can be squashed (typos, WIP commits, fixups, etc.)
3. Group related commits together
4. Show you a plan for squashing
5. Create interactive rebase commands or perform the squash with your approval

## Setup

Create an agent with git tools:

```bash
jazz agent create
# Name: git-assistant
# Tools: Git
```

## Usage

```bash
jazz agent chat git-assistant
```

Then ask Jazz to analyze and clean up your commit history. Jazz will:

- Review recent commits (default: last 20 commits)
- Identify commits that should be squashed
- Group related commits logically
- Show you the proposed changes
- Perform interactive rebase to squash commits

## Example Output

```bash
$ jazz agent chat git-assistant

You: Analyze my git history and help me squash useless commits

Agent: [Analyzing git history...]
       Reviewing last 20 commits on branch 'feature/auth-refresh'

       Found several commits that can be squashed:

       📊 Commit Analysis:

       Group 1: JWT Token Refresh Feature (5 commits)
       - abc123 "feat: add JWT token refresh logic"
       - def456 "fix: typo in refresh function name"
       - ghi789 "wip: testing refresh flow"
       - jkl012 "fix: correct refresh token validation"
       - mno345 "feat: complete JWT refresh implementation"

       → Suggested: Squash into "feat: implement JWT token refresh"

       Group 2: Test Coverage (3 commits)
       - pqr678 "test: add refresh token tests"
       - stu901 "test: fix failing test"
       - vwx234 "test: add edge case tests"

       → Suggested: Squash into "test: add comprehensive refresh token tests"

       Group 3: Documentation (2 commits)
       - yza567 "docs: update auth docs"
       - bcd890 "docs: fix typo in auth docs"

       → Suggested: Squash into "docs: update authentication documentation"

       Standalone commits (keep as-is):
       - efg123 "feat: add Redis caching layer"
       - hij456 "refactor: improve error handling"

       📋 Squash Plan:

       Will squash 10 commits into 3 meaningful commits:
       - Group 1: 5 commits → 1 commit
       - Group 2: 3 commits → 1 commit
       - Group 3: 2 commits → 1 commit

       This will clean up your history while preserving all changes.

       Should I proceed with the interactive rebase? (yes/no): yes

       Agent: [Starting interactive rebase...]
              ✓ Squashed Group 1 commits
              ✓ Squashed Group 2 commits
              ✓ Squashed Group 3 commits

              ✓ Rebase complete! History cleaned up.

              Note: You may need to force push if these commits were already pushed:
              git push --force-with-lease origin feature/auth-refresh
```

## More Examples

- `"Analyze last 30 commits and suggest what to squash"`
- `"Squash all WIP and fixup commits in my branch"`
- `"Clean up my commit history, keeping only meaningful commits"`
- `"Find and squash commits with typos or minor fixes"`
- `"Group related commits together and create a clean history"`

## Tips

- Jazz identifies WIP commits, typos, fixups, and related commits automatically
- Related commits are grouped logically (by feature, by type, etc.)
- Standalone meaningful commits are preserved
- All operations require your explicit approval
- If commits were already pushed, you'll need to force push (Jazz will warn you)
- Use `--force-with-lease` for safer force pushing
