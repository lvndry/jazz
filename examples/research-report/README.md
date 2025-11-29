# Research & Report

Use Jazz to research topics and generate comprehensive reports by aggregating information from multiple sources.

## Example

**Ask:** `"collect latest guides on TypeScript 5.5 and summarize sources"`

**Jazz will:**

1. Search the web for TypeScript 5.5 guides
2. Aggregate information from multiple sources
3. Output a concise report with links and key takeaways

## Setup

Create an agent with web search capabilities:

```bash
jazz agent create
# Name: research-assistant
# Tools: Web Search
```

## Usage

```bash
jazz agent chat research-assistant
```

Then ask your research question. Jazz will search the web, gather information, and present a synthesized report.

## More Examples

- `"Research best practices for React performance optimization"`
- `"Find the latest security vulnerabilities in Node.js and summarize"`
- `"Compare the top 3 project management tools and create a comparison report"`
