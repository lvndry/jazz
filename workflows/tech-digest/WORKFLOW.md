---
name: tech-digest
description: Daily comprehensive AI & tech trends digest with deep research
schedule: "0 8 * * *"
autoApprove: true
skills:
  - deep-research
---

# Daily Tech & AI Digest

Generate a comprehensive daily digest of the most important developments in AI, technology, startups, and tech investments from the last 24 hours.

## Research Scope

Investigate these areas thoroughly:

### 1. AI & Machine Learning
- New model releases and benchmarks
- Research breakthroughs (check Hugging Face Papers, arXiv)
- Tool and framework updates
- AI safety and policy developments

### 2. Tech Industry News
- Major product launches and updates
- Company announcements and pivots
- Tech layoffs or hiring trends
- Regulatory news (EU, US, China)

### 3. Startups & Investments
- Funding rounds (Series A, B, C, etc.)
- Notable acquisitions
- New startup launches
- VC trends and insights

### 4. Developer & Open Source
- Trending GitHub repositories
- New developer tools
- Framework updates (React, Next.js, Rust, etc.)
- API launches

## Sources to Check

Research across these platforms:

- **Twitter/X**: Tech influencers, AI researchers, VCs
- **Reddit**: r/MachineLearning, r/artificial, r/technology, r/startups, r/programming
- **Hugging Face**: Daily Papers, trending models, new spaces
- **Hacker News**: Top stories from the last 24 hours
- **TechCrunch**: Funding news, startup coverage
- **The Verge**: Product news, industry trends
- **Ars Technica**: Deep tech analysis
- **Product Hunt**: New launches
- **GitHub Trending**: Hot repositories

## Output Requirements

**DO NOT ask clarifying questions. Proceed directly with research.**

Use the `deep-research` skill to conduct thorough multi-source research. Skip the planning questions phase - go straight to searching and synthesizing.

### Report Structure

Create a markdown file with this structure:

```markdown
# Tech & AI Digest - [Date]

## 🔥 Top Stories
[3-5 most significant developments of the day]

## 🤖 AI & Machine Learning
### New Models & Research
[Notable papers, model releases, benchmarks]

### Tools & Frameworks
[New AI tools, updates, libraries]

### Industry Moves
[Company AI initiatives, partnerships]

## 💰 Funding & Investments
### Funding Rounds
[Startups that raised, amounts, investors]

### Acquisitions
[M&A activity]

### VC Insights
[Notable VC commentary, market trends]

## 🚀 Startups & Products
### Launches
[New products, features, services]

### Trending on Product Hunt
[Notable launches]

## 💻 Developer News
### Trending Repositories
[Hot GitHub repos with brief descriptions]

### Framework Updates
[Major version releases, breaking changes]

## 📊 Market Trends
[Brief analysis of overall tech market sentiment]

## 🔗 Sources
[List all sources used]
```

## File Storage

Save the digest to: `$HOME/tech-digests/[YEAR]/[Month]/[DD].md`

For example, if today is February 3, 2026:
- Path: `~/tech-digests/2026/February/03.md`

Create the directories if they don't exist.

## Execution Notes

- Focus on **signal over noise** - only include truly noteworthy items
- Prioritize **actionable insights** over general news
- Include **direct links** to sources when possible
- Keep summaries **concise but informative**
- Note any **emerging patterns** across sources
- Total report should be **comprehensive but scannable** (aim for 1500-3000 words)
