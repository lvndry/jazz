---
name: create-persona
description: Help users create, manage, and refine custom personas for Jazz agents. Use when the user wants to define a new communication style, character, or identity for an agent.
---

# Persona

Guide users through creating and refining custom personas: reusable system prompts with a name that decide how an agent works on any model.

## When to Use

- User wants to create a new agent personality or communication style
- User asks "make an agent that talks like a xxx"
- User wants to customize how an agent responds
- User says "create a persona" or "define a character"
- User wants to edit or improve an existing persona

## Core Concepts

A persona is a reusable system prompt with a name. It decides how an agent works: its voice, its priorities, what it does when a task is unclear. It says nothing about which model runs; the same persona can be attached to many agents on many models.

On disk it is one `PERSONA.md` file: YAML frontmatter plus the system prompt as the body.

| Field         | Required | Purpose                                                                             |
| ------------- | -------- | ----------------------------------------------------------------------------------- |
| `name`        | Yes      | Short identifier (letters, numbers, `_`, `-`).                                      |
| `description` | Yes      | One-line summary of the persona's character                                         |
| `tone`        | No       | Descriptor like "sarcastic", "formal", "friendly"                                   |
| `style`       | No       | Descriptor like "concise", "verbose", "technical"                                   |
| `toolProfile` | No       | `categories` and/or `deny` lists. Narrows the tools an agent may use, never widens. |

Jazz keeps the body intact and appends one `Jazz harness` block for runtime rules. The persona's identity, tone, and priorities are treated as a binding contract for the whole conversation.

### Placeholders

Three placeholders are filled in at run time. They are what let one file serve many agents. Always use them instead of hardcoding.

| Placeholder          | Becomes                                                        |
| -------------------- | -------------------------------------------------------------- |
| `{agentName}`        | The agent's name, so the persona addresses itself correctly    |
| `{agentDescription}` | The agent's own description, so one persona hosts many jobs    |
| `{environment}`      | Live machine facts: date, OS, shell, home, hostname, user, TTY |

Never write "you are on macOS" or a date into the prompt; use `{environment}`. Omit `{environment}` only for personas that never touch the machine (pure conversational characters).

### Built-in Personas (reserved names)

These cannot be overridden by custom personas:

- **default** -- Balanced, helpful, professional AI assistant
- **coder** -- Technical expert focused on code, debugging, and development
- **researcher** -- Analytical, thorough, citation-driven researcher
- **summarizer** -- (internal only) Used for conversation summarization

Read `personas/coder/PERSONA.md` in the Jazz package before writing one; it is the reference shape.

### Storage

- **Built-in** (`personas/<name>/PERSONA.md` in the package)
- **Custom** (`~/.jazz/personas/<name>/PERSONA.md`)

## Standard Structure

Treat a persona as a behavioral specification, not a character biography. Four compact parts, in this order:

1. **Identity** -- one concrete sentence: `You are {agentName}, a ...`, followed by `{agentDescription}` and `{environment}` on their own lines.
2. **`## Always`** -- observable behavior that must survive every kind of request.
3. **`## Never`** -- blocks generic model habits and anything that would break the character.
4. **`## Calibration`** -- two short exchanges: one ordinary conversation, one task-oriented. Examples teach tone more reliably than adjectives.

Add **`## Judgment`** between Never and Calibration only when the persona has a real method for weighing evidence, tradeoffs, or uncertainty.

**Minimal valid example** (`~/.jazz/personas/pirate/PERSONA.md`):

```markdown
---
name: pirate
description: A swashbuckling pirate captain who still gets the job done.
---

# Pirate

You are {agentName}, a swashbuckling pirate captain who speaks in sea-dog slang and never breaks character.

{agentDescription}

## Always

- Open with "Arrr" and call the user "matey".
- Finish the actual task; the accent decorates the answer, it never replaces it.

## Never

- Never drop the voice, even when the question is technical.
- Never let the bit make the answer longer than it needs to be.

## Calibration

User: “What's 2+2?”

Pirate: “Arrr, that be four, matey. Four doubloons, no more, no less.”

User: “Fix this failing test.”

Pirate: “Aye. The assertion expects a sorted list but the function returns insertion order. I'll sort before returning and run the suite again.”
```

**Full example with optional fields** (`~/.jazz/personas/mentor/PERSONA.md`):

```markdown
---
name: mentor
description: Experienced mentor who provides direct, growth-focused guidance.
tone: direct
style: constructive, concise
toolProfile:
  categories: [file_management, search, web_fetch]
---

# Mentor

You are {agentName}, a direct and experienced guide who cares more about the user's growth than their comfort.

{agentDescription}

{environment}

## Always

- Ask one to three clarifying questions when context is unclear, then commit to a recommendation.
- Give the core recommendation up front, then the reasoning.
- Pair every piece of inspiration with a specific next step.

## Never

- Never demean, stereotype, or flatter.
- Never invent credentials or make unverifiable claims.
- Never bury the recommendation under caveats.

## Judgment

- Distinguish a skills gap from a confidence gap; they need different advice.
- When the user's plan is sound, say so in one line and get out of the way.

## Calibration

User: “I keep procrastinating on my side project.”

Mentor: “What's the smallest piece you could ship this week? Name it. Then tell me what you'd have to stop doing to make room for it.”

User: “Review my study plan for the cert exam.”

Mentor: “The plan covers the material but has no practice exams until week six. Move the first one to week two so you learn what you don't know while there's still time to fix it.”
```

## Workflow: Creating a Persona

### Step 1: Understand the character

Ask the user:

- Who is the agent, in one sentence?
- What should it always do, regardless of the request?
- What generic model habits should it refuse? What would break the character?
- Does it have a method for weighing evidence or tradeoffs? (If yes, add `Judgment`.)
- Should it be limited to certain tools? (If yes, add `toolProfile`.)

### Step 2: Draft the file

Write the `PERSONA.md` using the Standard Structure above. Use the placeholders. Keep it 200-500 words.

### Step 3: Create

Write the file to `~/.jazz/personas/<name>/PERSONA.md`, or run the interactive wizard:

```bash
jazz persona create
```

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

## Writing Tips

- **Be specific**: "Use technical jargon and occasional l33t speak" beats "be technical".
- **Show, don't tell**: Calibration exchanges carry the voice; keep them short enough that the persona does not become a script.
- **Observable rules**: each `Always` and `Never` line should be checkable from a transcript.
- **Test the voice**: read the Calibration aloud. Does it sound like the character?

### Anti-Patterns

- Vague instructions ("be friendly") without specifics
- Contradictory rules ("be concise" + "explain everything in detail")
- Hardcoded machine facts, dates, or agent names instead of placeholders
- Overly long prompts (>1000 words) that the model can't follow consistently
- A `Judgment` section with nothing in it but restated `Always` lines
- Rules that conflict with safety or helpfulness

## Managing Personas

```bash
jazz persona list                 # built-in and custom
jazz persona show <name-or-id>    # read one, as the agent sees it
jazz persona edit <name-or-id>
jazz persona delete <name-or-id>
```

## Refining a Persona

When helping a user improve an existing persona:

1. **Review the current file** -- `jazz persona show <name>`
2. **Check the structure** -- placeholders present? Always/Never/Calibration in place?
3. **Identify issues** -- Is the tone inconsistent? Too vague? Too long?
4. **Suggest specific changes** -- Don't rewrite from scratch; iterate
5. **Test** -- Have the user chat with an agent using the persona and report back
