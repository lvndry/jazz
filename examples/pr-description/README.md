# Automated PR Description Generation

Generate detailed PR descriptions automatically from your git changes and commit history.

## Example

**Ask:** `"I'm about to create a PR. Generate a description from my changes"`

**Jazz will:**

1. Analyze git diff and commit history
2. Identify changed files and their purposes
3. Categorize changes (features, fixes, refactoring, etc.)
4. Generate a comprehensive PR description with:
   - Summary
   - List of changes
   - Technical details
   - Testing information
   - Breaking changes (if any)
   - Checklist

## Setup

Create an agent with git and file system tools:

```bash
jazz agent create
# Name: pr-generator
# Tools: Git, File System
```

## Usage

```bash
jazz agent chat pr-generator
```

Then ask Jazz to generate a PR description. Jazz will:

- Analyze your git changes
- Review commit messages
- Generate a well-structured PR description
- Copy it to clipboard or save to a file

## Example Output

```
You: I'm about to create a PR. Generate a description from my changes

Agent: [Analyzes git diff and commits]

Found changes in:
- src/auth/jwt.ts (token refresh logic)
- src/middleware/auth.ts (new middleware)
- tests/auth.test.ts (12 new tests)

Generated PR description:

---
## Summary
Implements JWT token refresh mechanism to improve user experience and security.

## Changes
- ✨ Add automatic token refresh before expiration
- 🔒 Implement refresh token rotation for security
- 🧪 Add comprehensive test coverage (12 new tests)
- 📝 Update authentication documentation

## Technical Details
- Tokens now refresh 5 minutes before expiration
- Refresh tokens are single-use and rotate on each refresh
- Added Redis caching for refresh token blacklist
- Backward compatible with existing auth flow

## Testing
- All existing tests passing
- New tests cover refresh flow, rotation, and edge cases
- Manual testing completed on staging

## Breaking Changes
None - fully backward compatible

## Checklist
- [x] Tests added/updated
- [x] Documentation updated
- [x] No breaking changes
- [x] Tested locally
---

Copy this to your PR?

You: yes

Agent: ✓ Copied to clipboard
Ready to paste into GitHub!
```

## More Examples

- `"Generate a PR description for my current branch"`
- `"Create a PR description comparing main and my feature branch"`
- `"Generate PR description and save it to pr-description.md"`

## Tips

- Jazz analyzes both the diff and commit messages
- The description follows standard PR template formats
- Breaking changes are automatically highlighted
- You can ask Jazz to modify the description before using it



