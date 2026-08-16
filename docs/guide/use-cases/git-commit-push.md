# Git Commit and Push Workflow

Automate the process of committing your changes with intelligent commit messages and pushing to remote.

## Example

**Ask:** `"Read my uncommitted changes, commit them with a short and long commit message, then push"`

**Jazz will:**

1. Check git status to see uncommitted changes
2. Read and analyze the diffs
3. Generate a short commit message (for `-m`)
4. Generate a detailed long commit message (for the body)
5. Show you the commit message for approval
6. Commit the changes
7. Push to the remote repository

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

Then ask Jazz to commit your changes. Jazz will:

- Analyze your uncommitted changes
- Generate appropriate commit messages
- Show you what will be committed
- Ask for approval before committing and pushing

## Example Output

```bash
$ jazz agent chat git-assistant

You: Read my uncommitted changes, commit them with a short and long commit message, then push

Agent: [Checking git status...]

Found 3 modified files:
- src/auth/jwt.ts
- src/middleware/auth.ts
- tests/auth.test.ts

[Analyzing changes...]

Suggested commit message:

Short: "feat: implement JWT token refresh with rotation"

Long:
"Add automatic token refresh mechanism that refreshes tokens
5 minutes before expiration. Implements single-use refresh token
rotation for enhanced security. Adds Redis caching for refresh
token blacklist to prevent replay attacks.

- Add automatic refresh 5min before expiration
- Implement single-use refresh token rotation
- Add Redis caching for refresh token blacklist
- Add 12 new tests covering refresh flow"

Should I commit and push? (yes/no): yes

Agent: ✓ Committed successfully
      ✓ Pushed to origin/main
```

## More Examples

- `"What changed in my code since yesterday?"`
- `"Create a commit for my changes with a descriptive message"`
- `"Generate a commit message for my staged changes"`
- `"Commit my changes and push to the remote"`

## Tips

- Jazz automatically detects conventional commit message formats
- All git operations require your approval before execution
- Jazz will show you exactly what will be committed before proceeding
- The commit message will follow conventional commit standards when possible
