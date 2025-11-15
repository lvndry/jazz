# Example: Content Creation Skill

A comprehensive skill for creating, optimizing, and publishing content across multiple platforms.

## Directory Structure

```
skills/content-creation/
├── SKILL.md
├── content-types.md
├── seo-guidelines.md
├── platform-specs.md
├── scripts/
│   ├── generate-content.py
│   ├── optimize-seo.py
│   ├── create-images.py
│   ├── schedule-posts.py
│   └── analyze-performance.py
├── templates/
│   ├── blog-post.md
│   ├── social-media.json
│   ├── newsletter.html
│   └── product-description.md
└── configs/
    ├── brand-voice.json
    ├── content-calendar.json
    └── platform-settings.json
```

## SKILL.md

````yaml
---
name: content-creation
version: 1.8.0
description: Create, optimize, and publish content across blogs, social media, and newsletters
author: Marketing Team
tags: [content, marketing, social-media, seo, writing, publishing]
category: Marketing
complexity: intermediate

tools:
  required:
    - read_file
    - write_file
  optional:
    - http_request
    - execute_command
    - send_email

triggers:
  keywords:
    - content
    - write
    - create
    - post
    - blog
    - social media
    - tweet
    - article
    - newsletter
  patterns:
    - "(write|create|draft) (a )?(blog post|article|tweet)"
    - "(generate|write) (social media )?content"
    - "create (a )?newsletter"
    - "optimize (for )?seo"
    - "schedule (posts|content)"
  context_hints: []

risk_level: low
approval_required: false

sections:
  - content-types.md
  - seo-guidelines.md
  - platform-specs.md

estimated_duration: 5-15 minutes
prerequisites:
  - Brand voice guidelines (optional)
  - Target audience defined (optional)

last_updated: 2024-01-15
---

# Content Creation Skill

Create engaging, optimized content for blogs, social media, newsletters, and more.

## Overview

Content is king, but creating quality content consistently is challenging. This skill helps you:
- Generate content ideas based on trends
- Write compelling copy aligned with brand voice
- Optimize content for SEO
- Adapt content for different platforms
- Schedule and publish content
- Track performance and iterate

## Core Capabilities

1. **Content Generation**
   - Blog posts and articles
   - Social media posts
   - Email newsletters
   - Product descriptions
   - Landing page copy
   - Video scripts

2. **SEO Optimization**
   - Keyword research integration
   - Meta descriptions
   - Header optimization
   - Internal linking
   - Readability scoring

3. **Platform Adaptation**
   - Twitter/X: 280 chars, hashtags
   - LinkedIn: Professional tone
   - Instagram: Visual-first, captions
   - Facebook: Community engagement
   - TikTok: Short-form video scripts

4. **Content Planning**
   - Editorial calendar
   - Topic clustering
   - Content series
   - Seasonal planning

5. **Performance Tracking**
   - Engagement metrics
   - SEO rankings
   - Conversion tracking
   - A/B testing

## Basic Workflow

### Step 1: Define Content Brief

```typescript
const brief = {
  type: "blog_post",
  topic: "Introduction to TypeScript",
  audience: "junior developers",
  keywords: ["typescript", "javascript", "type safety"],
  tone: "educational, friendly",
  length: "1500-2000 words",
  cta: "Sign up for our TypeScript course"
};
````

### Step 2: Generate Content

```python
# scripts/generate-content.py
content = generate_content(
    topic=brief.topic,
    audience=brief.audience,
    tone=brief.tone,
    length=brief.length,
    brand_voice=load_brand_voice()
)
```

**Output Structure:**

```markdown
# Introduction to TypeScript: A Beginner's Guide

## Meta

- Title: Introduction to TypeScript: A Beginner's Guide
- Description: Learn TypeScript basics and why it's essential for modern web development
- Keywords: typescript, javascript, type safety, web development
- Word Count: 1,847

## Content

[Generated article with proper structure, examples, and CTAs]

## SEO Score: 85/100

✅ Target keyword in title ✅ Good readability (Grade 8) ✅ Proper heading structure ⚠️ Consider
adding more internal links
```

### Step 3: Optimize for SEO

```python
# scripts/optimize-seo.py
optimized = optimize_for_seo(
    content=content,
    target_keywords=brief.keywords,
    competitors=["competitor-url-1", "competitor-url-2"]
)
```

### Step 4: Adapt for Multiple Platforms

```python
# Create social media variants
social_posts = {
    "twitter": create_thread(content, max_tweets=5),
    "linkedin": create_linkedin_post(content),
    "instagram": create_instagram_caption(content),
    "facebook": create_facebook_post(content)
}
```

### Step 5: Schedule Publishing

```python
# scripts/schedule-posts.py
schedule_content({
    "blog": {"platform": "wordpress", "date": "2024-02-01 09:00"},
    "twitter": {"platform": "twitter", "date": "2024-02-01 10:00"},
    "linkedin": {"platform": "linkedin", "date": "2024-02-01 14:00"}
})
```

## Content Types

### Blog Post

**Structure:**

- Compelling headline
- Engaging introduction (hook)
- Structured body (H2, H3 headings)
- Examples and visuals
- Clear conclusion
- Strong CTA

**Best Practices:**

- 1,500+ words for SEO
- Target one primary keyword
- Use short paragraphs (3-4 sentences)
- Include images/diagrams
- Add internal links

**Example:**

```markdown
# How to Write Clean TypeScript Code: 7 Best Practices

Writing clean code isn't just about making it work—it's about making it maintainable, scalable, and
enjoyable to work with. In this guide, we'll explore 7 best practices that will transform your
TypeScript code.

## 1. Use Explicit Type Annotations

While TypeScript's type inference is powerful, explicit types make your code more readable...

[Rest of article]

## Ready to Level Up Your TypeScript Skills?

Join 10,000+ developers in our TypeScript Mastery course. [Sign up today]
```

### Social Media Post

#### Twitter/X Thread

**Structure:**

- Hook tweet (stand-alone)
- Supporting tweets (2-5)
- Conclusion + CTA

**Example:**

```
Tweet 1/5:
TypeScript tip: Use `unknown` instead of `any` when you don't know the type.

Why? 🧵👇

Tweet 2/5:
`any` disables all type checking:
let data: any = "hello";
data.toUpperCase(); // No error
data.nonExistent(); // No error ❌

Tweet 3/5:
`unknown` forces you to check the type first:
let data: unknown = "hello";
if (typeof data === "string") {
  data.toUpperCase(); // ✅ Safe!
}

Tweet 4/5:
This catches bugs at compile time instead of runtime.

Your future self will thank you. 🙏

Tweet 5/5:
Want more TypeScript tips? Follow @YourHandle and check out our free guide:
[link]
```

#### LinkedIn Post

**Structure:**

- Professional hook
- Value-driven content
- Personal experience/insight
- Engagement question

**Example:**

```
🚀 Just shipped a major refactor using TypeScript's new features.

3 months ago, our codebase had 200+ runtime errors per week.
Today? Down to less than 10.

Here's what made the difference:

1️⃣ Strict null checks
   Caught 40% of our bugs before they reached production

2️⃣ Union types for state management
   Eliminated impossible states in our UI

3️⃣ Template literal types
   Made our API routes type-safe

The best part? Our team's velocity increased by 30% because we spend
less time debugging and more time building features.

TypeScript isn't just about catching bugs—it's about building confidence.

What's been your biggest win with TypeScript?

#TypeScript #WebDevelopment #SoftwareEngineering
```

See [content-types.md](content-types.md) for all content types.

## SEO Guidelines

### On-Page SEO Checklist

- [ ] **Title Tag** (50-60 chars)
  - Include primary keyword
  - Front-load keyword
  - Make it compelling

- [ ] **Meta Description** (150-160 chars)
  - Include primary keyword
  - Compelling copy
  - Include CTA

- [ ] **URL Structure**
  - Short and descriptive
  - Include keyword
  - Use hyphens, not underscores

- [ ] **Heading Structure**
  - One H1 (title)
  - Multiple H2s (sections)
  - H3s for subsections
  - Include keywords naturally

- [ ] **Content Quality**
  - 1,500+ words (for competitive keywords)
  - Original and valuable
  - Proper grammar and spelling
  - Good readability (Grade 8-10)

- [ ] **Internal Linking**
  - Link to 3-5 related articles
  - Use descriptive anchor text
  - Link to high-authority pages

- [ ] **Images**
  - Descriptive alt text
  - Compressed file size
  - Relevant to content

- [ ] **Mobile Optimization**
  - Responsive design
  - Fast load time (<3s)
  - Easy to read on mobile

### Keyword Optimization

```python
def optimize_keyword_density(content, target_keyword):
    """
    Optimal keyword density: 1-2%
    """
    word_count = len(content.split())
    keyword_count = content.lower().count(target_keyword.lower())
    density = (keyword_count / word_count) * 100

    if density < 1:
        return "Add more mentions of target keyword"
    elif density > 2:
        return "Reduce keyword stuffing"
    else:
        return "Keyword density optimal"
```

See [seo-guidelines.md](seo-guidelines.md) for comprehensive SEO guide.

## Platform Specifications

### Twitter/X

- **Character limit**: 280 chars
- **Best time to post**: 8-10am, 6-9pm
- **Hashtags**: 1-2 max
- **Images**: 1200x675px (16:9)
- **Tone**: Conversational, casual
- **Engagement**: Ask questions, use polls

### LinkedIn

- **Character limit**: 3,000 chars (but keep under 150 for feed)
- **Best time to post**: Tue-Thu, 7-8am, 5-6pm
- **Hashtags**: 3-5 relevant
- **Images**: 1200x627px
- **Tone**: Professional, thoughtful
- **Engagement**: Industry insights, share experiences

### Instagram

- **Caption limit**: 2,200 chars
- **Best time to post**: Mon-Fri, 11am, 2pm
- **Hashtags**: 5-10 in caption or first comment
- **Images**: 1080x1080px (square) or 1080x1350px (portrait)
- **Tone**: Visual-first, lifestyle
- **Engagement**: Stories, Reels, carousel posts

### Blog/Website

- **Word count**: 1,500-2,500 words for SEO
- **Paragraph length**: 3-4 sentences
- **Sentence length**: 15-20 words average
- **Readability**: Grade 8-10
- **Tone**: Match brand voice
- **Formatting**: Headers, bullets, images

See [platform-specs.md](platform-specs.md) for all platforms.

## Code Resources

### scripts/generate-content.py

AI-powered content generation.

**Usage:**

```bash
python scripts/generate-content.py \
  --type blog_post \
  --topic "TypeScript Best Practices" \
  --keywords "typescript,best practices,clean code" \
  --length 2000 \
  --tone professional \
  --output content.md
```

**Features:**

- Brand voice integration
- SEO optimization
- Multiple formats
- Content variations

### scripts/optimize-seo.py

SEO analysis and optimization.

**Usage:**

```bash
python scripts/optimize-seo.py \
  --file content.md \
  --target-keyword "typescript" \
  --competitors competitor1.com,competitor2.com \
  --report seo-report.html
```

**Checks:**

- Keyword density
- Readability score
- Meta tags
- Heading structure
- Internal links
- Image optimization

### scripts/create-images.py

Generate social media images.

**Usage:**

```bash
python scripts/create-images.py \
  --template twitter \
  --text "10 TypeScript Tips" \
  --background gradient \
  --output image.png
```

### scripts/schedule-posts.py

Schedule content across platforms.

**Usage:**

```bash
python scripts/schedule-posts.py \
  --content content.md \
  --platforms twitter,linkedin,facebook \
  --date "2024-02-01 09:00" \
  --timezone UTC
```

## Brand Voice Configuration

`configs/brand-voice.json`:

```json
{
  "personality": {
    "traits": ["friendly", "professional", "helpful", "innovative"],
    "avoid": ["stuffy", "condescending", "overly technical"]
  },
  "tone": {
    "default": "conversational professional",
    "blog": "educational and friendly",
    "social": "casual and engaging",
    "email": "personal and helpful"
  },
  "vocabulary": {
    "preferred": ["community", "empowering", "simple", "effective"],
    "avoid": ["synergy", "disrupt", "paradigm shift"]
  },
  "punctuation": {
    "use_contractions": true,
    "use_emojis": "social media only",
    "use_exclamation": "sparingly"
  },
  "formatting": {
    "paragraphs": "short (3-4 sentences)",
    "lists": "frequent use",
    "headers": "clear and descriptive"
  }
}
```

## Example Usage

### Example 1: Create Blog Post

```
User: "Write a blog post about TypeScript benefits"

Agent: [Loads content-creation skill]
Agent: "✍️ Creating blog post about TypeScript benefits...

Let me gather some information:
  • Target audience?
  • Desired word count?
  • Any specific points to cover?"

User: "Junior developers, 1500 words, focus on type safety and productivity"

Agent: [Loads brand-voice.json]
Agent: [Runs generate-content.py]
Agent: "📝 Blog post draft ready!

Title: 5 Ways TypeScript Boosts Developer Productivity
Word count: 1,847 words
Reading time: 7 minutes
SEO score: 88/100

Structure:
  1. Introduction (hook + value prop)
  2. Type Safety Reduces Bugs
  3. Better IDE Support
  4. Easier Refactoring
  5. Self-Documenting Code
  6. Scales with Your Team
  7. Conclusion + CTA

✅ SEO Optimized:
  • Target keyword 'TypeScript' used 18 times (1.2% density)
  • Meta description included
  • 5 internal link suggestions
  • Readability: Grade 9

Would you like me to:
  • Generate social media posts for this article
  • Create featured image
  • Schedule for publishing
  • Optimize further for SEO"
```

### Example 2: Social Media Campaign

```
User: "Create a week of Twitter content about our new product launch"

Agent: [Loads content-creation skill]
Agent: "📱 Creating Twitter campaign for product launch...

What's the product and key features?"

User: "Jazz CLI - AI agent automation tool. Key features: agent creation, workflow orchestration, multi-LLM support"

Agent: [Runs generate-content.py --type twitter_thread]
Agent: "🐦 7-Day Twitter Campaign Ready!

Day 1 - Monday (Teaser):
'Something exciting is coming this week... 👀

Hint: It involves AI agents, automation, and making your life easier.

Any guesses? 🤔'

Day 2 - Tuesday (Problem):
'Tired of repetitive tasks eating up your day?
❌ Manual email triage
❌ Repetitive code reviews
❌ Copy-paste automation scripts

What if AI could handle these for you? 🤔'

Day 3 - Wednesday (Solution):
'Meet Jazz 🎺 - Your AI agent army in a CLI

Create autonomous agents that:
✅ Triage your emails
✅ Review pull requests
✅ Monitor production
✅ And 100+ more use cases

All from your terminal. Beta launching Friday! 🚀'

Day 4 - Thursday (Features):
'Jazz is built different 🔥

🤖 Multiple AI providers (OpenAI, Anthropic, Mistral)
⚡️ Effect-TS for bulletproof reliability
🔧 Extensible tool system
📊 Built-in scheduling & workflows

TypeScript devs are gonna love this 😍'

Day 5 - Friday (Launch):
'🎺 Jazz is LIVE! 🎺

Create your first AI agent in 60 seconds:

npm install -g @jazz/cli
jazz agent create
jazz agent chat my-agent

Docs: [link]
GitHub: [link]

What agent will you build first? 👇'

Day 6 - Saturday (Social Proof):
'The response has been incredible! 🙏

'This is exactly what I needed' - @developer1
'Best CLI tool I've used this year' - @developer2

100+ agents created in first 24 hours 🎉

Share your agent creations! #JazzAgents'

Day 7 - Sunday (Community):
'Jazz community highlights 🌟

🏆 Most creative agent: Email-to-task converter
🚀 Most practical: Auto-deployment checker
😂 Most fun: Meme generator bot

Join our Discord to share yours: [link]

Thanks for an amazing launch week! 💙'

Would you like me to:
  • Add images to each tweet
  • Create LinkedIn versions
  • Schedule all posts
  • Add more threads for engagement"
```

### Example 3: Newsletter

```
User: "Create a monthly newsletter"

Agent: [Loads content-creation skill]
Agent: "📧 Creating monthly newsletter...

What content should I include?"

User: "Product updates, blog post roundup, community highlights"

Agent: [Runs generate-content.py --type newsletter]
Agent: "📬 Newsletter Draft Ready!

Subject Line Options:
  1. Jazz Monthly: New features + community spotlight 🎺
  2. Your monthly Jazz update (featuring auto-scaling!)
  3. What's new in Jazz + 3 agent recipes you'll love

Preview text:
'New agent templates, scheduling features, and a community spotlight...'

Content:
━━━━━━━━━━━━━━━━━━━━━━━
👋 Hi [Name],

Another month, another batch of AI automation wins!
Here's what's new in Jazz...

🚀 NEW FEATURES

1. Agent Scheduling
   Set your agents to run on cron schedules. Daily email
   triage? Weekly reports? All automatic now.

2. Workflow Orchestration
   Chain multiple agents together for complex workflows.

3. New LLM Support
   We added Google Gemini and xAI Grok support!

[Read full changelog →]

📚 POPULAR BLOG POSTS

• Building a Code Review Agent (8 min read)
• 10 Jazz Recipes for Developers (5 min read)
• How We Handle Context Windows (6 min read)

🌟 COMMUNITY SPOTLIGHT

@developer created an agent that automatically generates
release notes from git commits. Genius!

Check it out: [link]

💡 AGENT RECIPE OF THE MONTH

'Daily standup prep agent'
Collects your PRs, tickets, and meetings for quick standup prep.

[View recipe →]

📅 UPCOMING

• Jazz Skills system (Feb 15)
• Agent handoff patterns (Feb 22)
• Community call (Feb 28)

━━━━━━━━━━━━━━━━━━━━━━━

Keep automating!
The Jazz Team 🎺

P.S. What agent should we build next? Reply and let us know!

[Unsubscribe] [Update preferences]
━━━━━━━━━━━━━━━━━━━━━━━

Email Stats:
  Word count: 285
  Read time: 90 seconds
  Links: 8
  CTAs: 4

Would you like me to:
  • Create HTML version
  • A/B test subject lines
  • Schedule for sending
  • Create social media posts announcing newsletter"
```

## Best Practices

1. **Know Your Audience**
   - Research their pain points
   - Use their language
   - Address their objections

2. **Hook Early**
   - First sentence must grab attention
   - Promise value upfront
   - Use questions or surprising stats

3. **Write for Scanning**
   - Short paragraphs
   - Descriptive headers
   - Bullet points
   - Bold key points

4. **Strong CTAs**
   - One primary CTA
   - Make it specific
   - Create urgency (but don't manipulate)

5. **Optimize, Don't Stuff**
   - Natural keyword usage
   - Focus on readability first
   - SEO is secondary to value

## Content Calendar Template

```json
{
  "2024-02": {
    "week_1": {
      "blog": "TypeScript Best Practices",
      "social": ["Twitter thread", "LinkedIn post"],
      "newsletter": null
    },
    "week_2": {
      "blog": "Building AI Agents",
      "social": ["Product demo video", "Twitter tips"],
      "newsletter": "Monthly update"
    },
    "themes": ["developer productivity", "AI automation"],
    "campaigns": ["product launch"]
  }
}
```

## Related Skills

Works well with:

- **seo-optimization**: Deep SEO analysis
- **social-media-management**: Platform-specific posting
- **analytics**: Track content performance

## Changelog

### v1.8.0 (2024-01-15)

- Added AI content generation
- Platform-specific optimization
- Brand voice integration

### v1.5.0 (2023-12-01)

- SEO scoring
- Multi-platform adaptation
- Content calendar

### v1.0.0 (2023-10-01)

- Initial release
- Basic templates
- Social media support

```

---

This content creation skill demonstrates:
- ✅ Multi-format content generation
- ✅ SEO optimization
- ✅ Platform-specific adaptation
- ✅ Brand voice consistency
- ✅ Campaign planning
- ✅ Performance tracking

```
