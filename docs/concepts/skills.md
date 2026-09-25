---
description: "What a Jazz skill is, how progressive loading keeps a large skill library off the context budget, where skills come from, and which one wins on a name collision."
---

# Skills

A skill is a folder led by `SKILL.md`. It teaches the model a procedure: when this kind of work
comes up, here are the steps, the conventions, and the traps. It may ship scripts, templates, and
reference files alongside.

**A skill grants nothing.** It can teach an agent to drive a CLI, but the agent still needs
`execute_command`, the binary still has to be installed, and the approval policy still applies.

Instructions and capabilities are different things. A document that could quietly widen an
agent's reach would be a very odd security boundary.

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

On a name collision the more specific source wins, so a project can override a built-in skill.

That is the point of the project tier. A repository-specific procedure belongs next to the code
it governs, and it should beat your personal default without you disabling anything.

Jazz ships skills for research, journaling, meeting notes, email, calendar, Obsidian, and
creating personas, workflows and skills themselves.

In an interactive terminal, `/skills` opens a searchable catalog of built-in, global,
shared-agent, project, and plugin skills. Type to filter by name, source, or description;
use Up and Down to choose a skill, Enter to read its full description and source
(and its location when file-backed),
and Escape to return to the list or conversation. Non-interactive sessions print the
complete catalog instead.

## The skill marketplace

The Jazz website's [Marketplace](https://jazz-cli.vercel.app/library) publishes reviewed skills
alongside personas, workflows, and plugins. A marketplace skill is an instruction artifact: it
does not add tools, credentials, network access, or approval authority. Its instructions can still
steer an agent, so read the content and its source before installing it.

Install a skill from the cached catalog with `jazz skill browse`, `jazz skill search`, or
`jazz skill install <name>`. Jazz shows the complete `SKILL.md`, its source URL, and metadata before
writing it to `~/.jazz/skills/<name>/SKILL.md`; non-interactive installs must pass `--yes`. The
installer accepts only a single reviewed `SKILL.md` and never executes files from the catalog.

The catalog is cached under `<jazz home>/cache/skill-registry.json`, works offline after its first
successful fetch, and can be pointed at a self-hosted library with `JAZZ_LIBRARY_URL`. The website
is curated through pull requests, so a listing is a review and provenance signal—not a claim that
the instructions are harmless or universally correct.

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
