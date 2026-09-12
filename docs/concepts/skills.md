---
description: "Teach Jazz agents repeatable procedures with portable Agent Skills that load progressively without spending context on irrelevant instructions."
---

# Skills in Jazz

A skill is a folder led by `SKILL.md`. It gives the model instructions and may include scripts, templates, or reference material.

Skills do not add privileged capabilities. A skill can teach an agent to call a CLI, but the agent still needs `execute_command`, the program must be installed, and the active approval policy still applies.

## Progressive loading

Jazz indexes skill names and descriptions in the initial prompt. The model uses `find_skills`, `load_skill`, and `load_skill_section` to retrieve details when a task needs them. Large reference files therefore do not consume context on unrelated turns.

Skills are discovered from built-in, user, and project locations. Project skills can override a same-named broader skill, making repository-specific procedures local to the code they govern.

Use a skill for repeatable know-how. Use a [tool](./tools.md) when the model needs a new callable capability, and a [workflow](./workflows.md) when a complete prompt should be invoked or scheduled as a unit.
