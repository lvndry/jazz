---
description: "What a Jazz skill is, how progressive loading keeps a large skill library off the context budget, where skills come from, and which one wins on a name collision."
---

# Skills

A skill gives an agent instructions for a kind of work, such as researching a topic,
writing meeting notes, or managing email. It is a folder with a `SKILL.md` file and optional
scripts, templates, and reference material.

Use skills to teach a repeatable procedure without putting the whole procedure in every prompt.

Jazz skills use the [Agent Skills](https://agentskills.io) format, so a skill written for another
tool that reads it works in Jazz, and a Jazz skill works there.

## Use a skill

Enter `/skills` in a conversation to browse available skills. Read one, then ask for a task
it covers, such as:

```text
Use the deep-research skill to compare these three approaches. Cite the sources
and recommend one for this project.
```

Jazz loads matching instructions when needed. For email, calendar, and other external
systems, install and configure the underlying tools first; a skill supplies instructions,
while the agent's tool permissions still control what it can do.
See [Email and calendar](../configure/email-calendar.md) for a working setup.

## Progressive loading

Jazz loads skill instructions on demand:

| Level | What the model sees                         | Loaded by                    |
| ----- | ------------------------------------------- | ---------------------------- |
| 1     | Every skill's name and one-line description | always, in the system prompt |
| 2     | One skill's full `SKILL.md`                 | `load_skill`                 |
| 3     | One referenced file inside it               | `load_skill_section`         |

`find_skills` searches the index when the one-line descriptions are not enough to decide.

## Skill locations

| Source   | Path                | Scope                              |
| -------- | ------------------- | ---------------------------------- |
| Built-in | ships with Jazz     | everywhere                         |
| Shared   | `~/.agents/skills/` | every tool that reads Agent Skills |
| Global   | `~/.jazz/skills/`   | all your projects                  |
| Project  | `./skills/`         | this repository only               |

On a name collision the more specific source wins, so a project can override a built-in skill.

## Compatibility with the Agent Skills format

Jazz finds a `SKILL.md` up to three folders deep in each location. The frontmatter needs a
`name` and a `description`; a skill missing either one is skipped, and the rest still load.
Other frontmatter fields, such as `license`, `compatibility`, `metadata`, and `allowed-tools`,
are accepted and ignored.

`allowed-tools` has no effect in Jazz: a skill supplies instructions, and the agent's own tool
permissions and approval policy decide what runs. Jazz does not check that `name` matches the
folder name.

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
`jazz skill add <name>`. Jazz shows the complete `SKILL.md`, its source URL, and metadata before
writing it to `~/.jazz/skills/<name>/SKILL.md`; non-interactive installs must pass `--yes`. The
installer accepts only a single reviewed `SKILL.md` and never executes files from the catalog.
Each marketplace skill page shows its `jazz skill add <name>` command alongside the full
instruction source, so you can review and install it without manually copying files.

After the first fetch, you can browse the cached catalog offline. To use an internal
library, set `JAZZ_LIBRARY_URL`.

Remove a global skill with `jazz skill remove <name>`. Jazz confirms before deleting the
whole `~/.jazz/skills/<name>/` directory, including its assets; non-interactive removal requires
`--yes`. Built-in, project, shared-agent, and plugin skills are outside this command's scope.
Linked skill roots or directories are refused. Removing a global override may reveal a skill
with the same name from another source on the next run.

## Skill, tool, or workflow

- A **skill** is know-how. Use it for a procedure the model should follow.
- A **[tool](./tools.md)** is a capability. Use it when the model needs to _do_ something new.
- A **[workflow](./workflows.md)** is a whole prompt plus its run settings. Use it when a
  complete job should be invoked or scheduled as a unit.

## Related

- [Tool inventory](../tools/index.md): `find_skills`, `load_skill`, `load_skill_section`
- [Workflows](./workflows.md): packaging a prompt rather than a procedure
- [Agents](./agents.md): which skills an agent can reach
