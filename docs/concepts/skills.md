# Skills: Give Your Agent Superpowers Without the Bloat

You've got an agent that can run shell commands, call tools, and search the web. But when you ask it to “plan this project” or “research this topic properly,” you don't want it to wing it every time. You want it to follow a **proven playbook**—decompose the ask, use the right steps, and output something consistent and useful.

That's what **Skills** are for in Jazz: packaged expertise your agent can discover and apply only when it matters.

---

## What's a Skill, Really?

A **Skill** is a folder that contains:

- **Instructions** (in `SKILL.md`) — when to use the skill, what to do step-by-step, and how to format output
- **References** (optional) — extra docs, checklists, or data the agent can pull in when needed
- **Scripts** (optional) — small utilities the skill can call

Think of it as a **reusable workflow + knowledge pack**. The agent doesn't carry all of that in every turn. It sees a short **name** and **description** for every skill. When your request matches one, it **loads** that skill's instructions and follows them. For deeper detail, it can load specific sections or files from inside the skill. So you get **domain expertise on demand**, without stuffing the context window with dozens of long guides.

---

## Why Skills Change How You Work

Without skills, the agent has to infer how to do “research” or “planning” or “release notes” from scratch every time. With skills:

- **You get consistency** — same structure for meeting notes, same pipeline for deep research, same checklist for code review.
- **You keep context lean** — the agent only pulls in the full instructions when a skill is relevant.
- **You can share and version** — put skills in a repo, copy them across projects, or install them globally.
- **The agent stays in control** — it still decides _when_ to use a skill and can combine skills with tools and shell.

So skills aren't “another kind of tool.” They're **how you teach your agent _how_ to do complex tasks**, while tools are _what_ it uses to do them.

---

## How Skills Work Under the Hood

Jazz uses a **progressive disclosure** model so the agent (and the context window) only see what's needed.

### Level 1: Discovery (always)

When a chat starts, the agent gets a **list of all available skills** with only:

- **name** — e.g. `deep-research`, `todo`, `commit-message`
- **description** — what the skill does and when to use it

So the agent knows “there's a skill for multi-source research” and “there's a skill for task lists” without reading thousands of lines. It uses these descriptions to decide if a skill is relevant to the user's request.

### Level 2: Load the playbook

When the agent decides a skill fits, it calls the **`load_skill`** tool with the skill name. That loads the full **SKILL.md** content: when to activate, step-by-step workflow, examples, and references to other files. The agent then follows that playbook (using other tools, shell, MCP, etc. as needed).

### Level 3: Go deeper when needed

For heavy skills (e.g. deep research, documentation), SKILL.md may point to extra docs—e.g. `references/verification-patterns.md`. The agent uses **`load_skill_section`** to pull in only those sections when the workflow demands it. So you get **detailed guidance without loading every skill's full manual up front**.

Net result: the agent can have access to many skills, but only pays the “token cost” for the ones it actually uses, and only for the depth it needs.

---

## Where Skills Live (and Who Wins)

Skills are merged from three places, with a clear priority:

| Source   | Path              | Scope                | Priority           |
| -------- | ----------------- | -------------------- | ------------------ |
| Built-in | Ships with Jazz   | Every project        | Base set           |
| Global   | `~/.jazz/skills/` | All your projects    | Overrides built-in |
| Local    | `./skills/` (cwd) | Current project only | Overrides global   |

If the same **name** exists in more than one place, **local wins over global, global over built-in**. So you can override the built-in `todo` or `documentation` with your own version in a project, or install a personal skill once in `~/.jazz/skills/` and use it everywhere.

---

## What's In the Box: Built-in Skills

Jazz ships with a set of skills that cover common workflows. The exact list can grow over time; here's the kind of thing you get:

- **todo** — Create and track task lists for multi-step work; great for planning and not dropping steps.
- **deep-research** — Multi-source research with query decomposition, verification, and synthesis.
- **skill-creator** — Create new skills (global or project-specific) with the right structure and metadata.
- **documentation** — Generate and maintain docs from code and context.
- **code-review** — Structured review with checklists and conventions.
- **commit-message** — Write consistent, conventional commit messages.
- **pr-description** — Draft PR descriptions from branch and changes.
- **email** — Email workflows (e.g. with Himalaya CLI).
- **browser-use** — Browser automation for testing, forms, screenshots, scraping.
- **create-groove** / **create-cron** — Define and schedule grooves.
- **digest** — Summarize and digest content from configured sources.
- **meeting-notes** — Turn transcripts or notes into structured meeting notes.
- **journal** — Journaling and reflection workflows.
- **obsidian** — Obsidian-specific structure, canvas, and markdown.
- **budget** / **investment-analysis** — Budgeting and investment analysis with references.
- **startup-brainstorm** — Ideation and founder-style frameworks.
- **decision-log** — Log and reference decisions.
- **boilerplate** — Generate project or file boilerplate.

In chat, you can type **`/skills`** to list all available skills (from all three sources) and open one to read its full SKILL.md. So you can see exactly what the agent sees when it loads a skill.

---

## Creating Your Own Skills

You don't need to be a contributor to add skills. You can add them **per project** or **for all projects**.

### Minimal shape

Each skill is a directory with at least one file:

- **`SKILL.md`** — Required. Markdown with YAML frontmatter and the main instructions.

Example:

```markdown
---
name: my-skill
description: Short description of what this does and when to use it (e.g. "Generate release notes from git history. Use when releasing or writing changelogs.")
---

# My Skill

## When to use

- Scenario A
- Scenario B

## Steps

1. Do X.
2. Do Y.
3. Output in format Z.
```

The **description** is what the agent sees in the Level 1 list. It's the main signal for “should I use this skill?” So make it concrete: what it does and when (e.g. trigger words or situations).

### Going further

- **references/** — Add `reference.md`, `checklist.md`, or topic-specific files. In SKILL.md, tell the agent when to use **`load_skill_section`** for a given file.
- **scripts/** — Small scripts the skill's instructions refer to; the agent can run them via shell or tools.

The **skill-creator** skill walks through purpose, location (global vs project), triggers, and structure, and helps you generate a proper SKILL.md. Use it when you want to add a new skill without memorizing the format.

---

## How the Agent Actually Uses Skills

When you send a message:

1. The system injects the list of available skills (name + description) and the short **Skills** instructions: if the request matches a skill, load it with `load_skill`, follow its workflow, and use `load_skill_section` when the skill references more detail.
2. The agent compares your request to those descriptions and decides whether to call `load_skill`.
3. If it does, it gets the full SKILL.md and follows it (calling other tools, shell, MCP, etc. as the skill specifies).
4. When the workflow says “for X, see references/foo.md,” the agent can call `load_skill_section(skill_name, "references/foo.md")` and then continue.

So the **full feature set** of skills is:

- **Discovery** — All skills visible by name and description in every conversation.
- **On-demand loading** — Full instructions only when a skill is chosen.
- **Section loading** — Deeper references loaded only when the workflow needs them.
- **Composability** — One skill can direct the agent to use tools, shell, other skills, or MCP.
- **Layering** — Built-in, global, and local skills with a clear override order.
- **Inspection** — `/skills` in chat to list and open any skill's SKILL.md.

---

## Quick Tips

- **Descriptions are the lever.** Clear, trigger-rich descriptions (“Use when…”) make the right skill get chosen more often.
- **Keep SKILL.md focused.** Put the main workflow and “when to use” in SKILL.md; move long reference material into separate files and load them by section.
- **Use the skill-creator skill** when you're adding a new skill so you get metadata and structure right.
- **Override built-ins when needed.** Drop a project-specific `./skills/todo/SKILL.md` (or full folder) to tailor behavior for that repo.

---

## Summary

**Skills** in Jazz are how you give your agent **repeatable, domain-specific workflows** without bloating every conversation. The agent discovers them by name and description, loads full instructions only when relevant, and can pull in extra sections on demand. You get consistency, shareability, and context efficiency, and you can extend the system with your own skills in `./skills/` or `~/.jazz/skills/`. For the full design and future directions (e.g. tool declarations, risk levels, composition), see the exploration doc [Agent Skills System](exploration/skills/agent-skills-system.md).
