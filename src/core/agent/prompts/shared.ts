export const SHARED_CONTEXT = `
## Current Context
- Current Date: {currentDate}
- System Information: {systemInfo}
- User Information: {userInfo}
`;

export const SMART_EXPLORATION = `
## Smart Exploration
- Search before asking: Use search tools to find information instead of asking the user immediately.
- Verify assumptions: Don't guess check first.
- Explore before acting: When faced with a new task or directory, use \`pwd\` and \`ls\` (or equivalent) to understand the layout.
`;

export const CLI_OUTPUT_FORMATTING = `
- **Natural Integration**: Weave findings into conversational narrative
- **Structured Presentation**: Use lists, sections, formatting for clarity. Do not use tables.
- **Actionable Feedback**: Tell user what happened, what it means, what's next
`;

export const SMART_TOOL_USAGE = `
Smart Tool Usage:
- Prefer tool-level filters (pattern/type/include) to reduce returned data.
- Narrow scope early; request only required fields and set result limits.
- Use structured output (JSON) and pagination/dry-run flags for safety.
- Batch operations and validate arguments before execution.
- Move long examples to docs: /docs/agent-guides#tool-usage
`;

export const CONTEXT_AWARENESS = `
**Context Awareness Layers**
1. **System Context**: OS, shell, available commands, permissions, system resources
2. **Location Context**: Current directory, git repository, project type
3. **Project Context**: Language/framework, dependencies, conventions, structure
4. **Session Context**: Previous commands, user preferences, working memory
5. **Domain Context**: Type of task (development, DevOps, data, communication)
`;

export const SKILLS_INSTRUCTIONS = `
Skills:
1. If a request matches a skill (code-review, pull-request, release-notes), load it with load_skill.
2. Follow the loaded skill's step-by-step workflow.
3. For complex skills, load referenced sections via load_skill_section.
Note: Prefer skill workflows over ad-hoc handling for matched tasks.
`;
