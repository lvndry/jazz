# Release Changelog Generation

Automatically generate comprehensive release changelogs by comparing git tags and analyzing commit history.

## Example

**Ask:** `"Generate a complete release changelog comparing the current tag and previous tag"`

**Jazz will:**

1. Find the current (latest) git tag
2. Find the previous tag
3. Analyze all commits between the two tags
4. Categorize changes (features, fixes, docs, breaking changes, etc.)
5. Generate a comprehensive, formatted changelog
6. Optionally create a GitHub release draft

## Setup

Create an agent with git and file system tools:

```bash
jazz agent create
# Name: changelog-generator
# Tools: Git, File System
```

## Usage

```bash
jazz agent chat changelog-generator
```

Then ask Jazz to generate a release changelog. Jazz will:

- Identify the current and previous tags
- Analyze all commits in between
- Categorize by type (features, bug fixes, documentation, etc.)
- Generate a well-formatted changelog
- Optionally create a GitHub release draft

## Example Output

```bash
$ jazz agent chat changelog-generator

You: Generate a complete release changelog comparing the current tag and previous tag

Agent: [Finding tags...]
       Current tag: v1.3.0
       Previous tag: v1.2.0

       [Analyzing commits...]
       Found 47 commits between v1.2.0 and v1.3.0

# Changelog v1.3.0

## 🚀 Features (12)
- Add user profile customization (#145)
- Implement dark mode toggle (#148)
- Add export to CSV functionality (#152)
- Support file attachments in comments (#156)
- Add real-time notifications (#160)

## 🐛 Bug Fixes (18)
- Fix memory leak in dashboard (#143)
- Resolve login redirect issue (#146)
- Correct timezone handling in reports (#151)
- Fix race condition in payment processing (#155)

## 📚 Documentation (8)
- Update API documentation (#144)
- Add deployment guide (#149)
- Improve getting started guide (#153)

## 🔧 Maintenance (9)
- Update dependencies (#147)
- Improve test coverage (+15%) (#150)
- Refactor authentication middleware (#154)

## ⚠️ Breaking Changes (2)
- Remove deprecated `oldAuth` method (#157)
- Change API response format for `/users` endpoint (#158)

Should I save this as CHANGELOG.md and create a GitHub release draft? (yes/no): yes

Agent: ✓ Saved to CHANGELOG.md
      ✓ Created GitHub release draft v1.3.0
```

## More Examples

- `"Generate changelog for commits since v1.2.0"`
- `"Create a release changelog for the last month"`
- `"Compare tags v1.2.0 and v1.3.0 and generate changelog"`
- `"Generate changelog and create a GitHub release"`
- `"Show me all commits since the last release"`

## Tips

- Jazz automatically detects conventional commit messages and categorizes them
- You can specify custom date ranges or tags for changelog generation
- The changelog follows standard formatting with emoji indicators
- Breaking changes are highlighted separately
- Jazz can create GitHub release drafts automatically
