---
description: "What a Jazz skill is, how progressive loading keeps a large skill library off the context budget, where skills come from, and which one wins on a name collision."
---

# Skills

A skill is a folder led by `SKILL.md`. It teaches the model a procedure: when this kind of work
comes up, here are the steps, the conventions, and the traps. It may ship scripts, templates, and
reference files alongside.

**A skill grants nothing.** It can teach an agent to drive a CLI, but the agent still needs
`execute_command`, the binary still has to be installed, and the approval policy still applies.
That separation is deliberate: instructions and capabilities are different things, and a document
that could quietly widen an agent's reach would be a very odd security boundary.

## Progressive loading

A useful skill library is far larger than a context window. Jazz loads it in three levels, so an
agent can have fifty skills and pay for the one it uses.

| Level | What the model sees                         | Loaded by                    |
| ----- | ------------------------------------------- | ---------------------------- |
| 1     | Every skill's name and one-line description | always, in the system prompt |
| 2     | One skill's full `SKILL.md`                 | `load_skill`                 |
| 3     | One referenced file inside it               | `load_skill_section`         |

Level 1 is what makes the choice possible: the agent knows a research playbook exists without
reading it. Level 3 is what makes big skills affordable, since a skill that points at
`references/verification-patterns.md` only pays for that file on a turn that needs it.
`find_skills` searches the index when the one-line descriptions are not enough to decide.

## Where they come from, and who wins

| Source   | Path                | Scope                                |
| -------- | ------------------- | ------------------------------------ |
| Built-in | ships with Jazz     | everywhere                           |
| Shared   | `~/.agents/skills/` | every tool that reads the convention |
| Global   | `~/.jazz/skills/`   | all your projects                    |
| Project  | `./skills/`         | this repository only                 |

On a name collision the more specific source wins, so a project can override a built-in skill
with its own version. That is the point of the project tier: a repository-specific procedure
belongs next to the code it governs, and it should beat your personal default without you having
to remember to disable anything.

Jazz ships skills for research, journaling, meeting notes, email, calendar, Obsidian, and
creating personas, workflows and skills themselves.

## Skill, tool, or workflow

Three things that sound similar and are not:

- A **skill** is know-how. Use it for a procedure the model should follow.
- A **[tool](./tools.md)** is a capability. Use it when the model needs to _do_ something new.
- A **[workflow](./workflows.md)** is a whole prompt plus its run settings. Use it when a
  complete job should be invoked or scheduled as a unit.

The common mistake is writing a skill when you needed a tool. If the agent cannot already
perform the action, no amount of instruction will teach it.

## Related

- [Tool inventory](../tools/index.md): `find_skills`, `load_skill`, `load_skill_section`
- [Workflows](./workflows.md): packaging a prompt rather than a procedure
- [Agents](./agents.md): which skills an agent can reach
