# Competitive Analysis Report

Research competitors and create comprehensive comparison reports.

## Example

**Ask:** `"Research the top 3 project management tools and create a comparison report with recommendations"`

**Jazz will:**

1. Research the specified competitors
2. Gather pricing information
3. Compare features and integrations
4. Analyze user reviews
5. Create a comprehensive comparison report
6. Provide recommendations based on your needs

## Setup

Create an agent with web search and file system tools:

```bash
jazz agent create
# Name: competitive-analyst
# Tools: Web Search, File System
```

## Usage

```bash
jazz agent chat competitive-analyst
```

Then ask Jazz to research and compare competitors. Jazz will:

- Research multiple competitors
- Gather comprehensive information
- Compare features, pricing, and reviews
- Generate a detailed report
- Provide recommendations

## Example Output

```
You: Research the top 3 project management tools and create a
     comparison report with recommendations

Agent: [Researching Asana, Monday.com, and Jira]

✓ Gathered pricing information
✓ Compared features and integrations
✓ Analyzed user reviews
✓ Created comparison report

# Project Management Tools Comparison

## Feature Comparison

| Feature | Asana | Monday.com | Jira |
|---------|-------|------------|------|
| Task Management | ✓ | ✓ | ✓ |
| Agile Boards | Limited | ✓ | ✓✓ |
| Automation | ✓ | ✓✓ | ✓ |
| Integrations | 200+ | 50+ | 3000+ |

## Recommendation

Monday.com for our cross-functional team:
- Best automation (saves ~5hrs/week)
- Intuitive for non-technical users
- Good Slack/GitHub integration

Saved to: docs/pm-tools-comparison.md
```

## More Examples

- `"Compare the top 5 CI/CD platforms"`
- `"Research and compare database options for our use case"`
- `"Compare authentication providers"`
- `"Analyze competitors in our market"`

## Tips

- Jazz can research multiple competitors simultaneously
- Reports include features, pricing, and user feedback
- Recommendations are tailored to your needs
- Reports are saved for future reference



