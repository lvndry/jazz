---
name: persona
description: Help users create, manage, and refine custom personas for Jazz agents. Use when the user wants to define a new communication style, character, or identity for an agent.
---

# Persona

Guide users through creating and refining custom personas reusable communication styles, tones, and behavioral rules that can be applied to any Jazz agent on any model.

## When to Use

- User wants to create a new agent personality or communication style
- User asks "make an agent that talks like a xxx"
- User wants to customize how an agent responds
- User says "create a persona" or "define a character"
- User wants to edit or improve an existing persona

## Core Concepts

A **persona** in Jazz defines:

| Field          | Required | Purpose                                                       |
| -------------- | -------- | ------------------------------------------------------------- |
| `name`         | Yes      | Short identifier (letters, numbers, `_`, `-`). Used in CLI.   |
| `description`  | Yes      | One-line summary of the persona's character                   |
| `systemPrompt` | Yes      | Core instruction that shapes agent behavior and communication |
| `tone`         | No       | Descriptor like "sarcastic", "formal", "friendly"             |
| `style`        | No       | Descriptor like "concise", "verbose", "technical"             |

### Built-in Personas (reserved names)

These cannot be overridden by custom personas:

- **default** -- Balanced, helpful, professional AI assistant
- **coder** -- Technical expert focused on code, debugging, and development
- **researcher** -- Analytical, thorough, citation-driven researcher
- **summarizer** -- (internal only) Used for conversation summarization

### Storage

Jazz scans two directories for persona.md files (like skills and workflows):
- **Built-in** (`personas/<name>/persona.md` in the package): `default`, `coder`, `researcher`, `summarizer`
- **Custom** (`~/.jazz/personas/<name>/persona.md`): Your own personas. Custom overrides built-in when names match.

Each persona is a markdown file with YAML frontmatter (name, description, tone?, style?) and the system prompt in the body.

### Manual persona.md Format

When creating a persona file by hand (instead of `jazz persona create`), create a folder and file: `~/.jazz/personas/<name>/persona.md`.

**Minimal valid example** (`~/.jazz/personas/pirate/persona.md`):

```markdown
---
name: pirate
description: A swashbuckling pirate captain
---

You are Captain Blackbeard. Speak like a pirate.

Rules:
- Say "Arrr" frequently.
- Call the user "matey".
- Never break character.
```

**Full example with optional fields** (`~/.jazz/personas/mentor/persona.md`):

```markdown
---
name: mentor
description: Experienced mentor who provides constructive, growth-focused guidance
tone: direct
style: deep-thinking, constructive, concise
---

You are Mentor, a direct and experienced guide.

Communication rules:
- Lead with understanding: ask 1-3 clarifying questions when context is unclear.
- Be direct and concise: give the core recommendation up-front.
- Balance inspiration with accountability: include specific next steps.

Behavioral constraints:
- Never demean or stereotype. Be empathetic and strength-based.
- Never invent credentials or make unverifiable claims.

Vocabulary:
- Use phrases like "own your craft", "do the work", "keep the faith".
```

## Workflow: Creating a Persona

### Step 1: Understand the character

Ask the user:

- What personality or character should the agent have?
- What tone? (sarcastic, warm, formal, casual, etc.)
- What style? (concise, verbose, technical, storytelling, etc.)
- Any specific vocabulary, catchphrases, or speech patterns?
- What should the agent avoid doing or saying?

### Step 2: Draft the system prompt

Write a system prompt that includes:

1. **Identity** -- Who the agent is (name, role, background)
2. **Communication rules** -- How it speaks (tone, vocabulary, sentence structure)
3. **Behavioral constraints** -- What it should/shouldn't do
4. **Examples** -- Optional example exchanges showing the style

### Step 3: Create via CLI

```bash
jazz persona create
```

This launches the interactive wizard. Alternatively, help the user fill in each field directly.

### Step 4: Apply to an agent

```bash
jazz agent create
# Select the custom persona during the wizard
```

Or edit an existing agent:

```bash
jazz agent edit <agentId>
# Change the persona field
```

## System Prompt Writing Guide

### Structure

```
You are [NAME], a [ROLE/CHARACTER].

## Communication Style
- [Rule 1]
- [Rule 2]
- [Rule 3]

## Behavioral Rules
- [Constraint 1]
- [Constraint 2]

## Vocabulary / Catchphrases
- [Pattern 1]
- [Pattern 2]
```

### Tips for Good Prompts

- **Be specific**: "Use technical jargon and occasional l33t speak" is better than "be technical"
- **Show, don't tell**: Include example phrases the agent might use
- **Set boundaries**: Define what the persona should NOT do
- **Keep it focused**: 200-500 words is the sweet spot. Too long dilutes the character
- **Test the voice**: Read the prompt aloud -- does it sound like the character?

### Anti-Patterns

- Vague instructions ("be friendly") without specifics
- Contradictory rules ("be concise" + "explain everything in detail")
- Overly long prompts (>1000 words) that the model can't follow consistently
- Rules that conflict with safety/helpfulness

```
Name: therapist
Description: Warm, empathetic counselor who helps process thoughts and decisions
Tone: warm
Style: reflective

System Prompt:
You are a thoughtful counselor and thinking partner. Your role is to help
users process their thoughts, make decisions, and gain clarity.

## Communication Style
- Ask open-ended questions before giving advice
- Reflect back what the user said to show understanding
- Use validating language ("That makes sense", "I can see why...")
- Be warm but professional

## Behavioral Rules
- Never rush to solutions -- help the user think through problems
- Acknowledge emotions and complexity
- Offer frameworks for decision-making rather than direct answers
- When appropriate, summarize key insights from the conversation

## Vocabulary
- "What I'm hearing is..."
- "How does that feel?"
- "Let's explore that a bit more..."
- "What would it look like if..."
```

## Managing Personas

### List all personas

```bash
jazz persona list
```

### View persona details

```bash
jazz persona show <name-or-id>
```

### Edit a persona

```bash
jazz persona edit <name-or-id>
```

### Delete a persona

```bash
jazz persona delete <name-or-id>
```

## Refining a Persona

When helping a user improve an existing persona:

1. **Review the current system prompt** -- `jazz persona show <name>`
2. **Identify issues** -- Is the tone inconsistent? Too vague? Too long?
3. **Suggest specific changes** -- Don't rewrite from scratch; iterate
4. **Test** -- Have the user chat with an agent using the persona and report back
5. **Iterate** -- Adjust based on real conversation results
