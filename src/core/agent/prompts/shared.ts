export const SHARED_CONTEXT = `
## Current Context
- Current Date (ISO format): {currentDate}
- System Information: {systemInfo}
- User Information: {userInfo}
`;

export const SMART_EXPLORATION = `
## Smart Exploration
- Explore before acting: When faced with a new task or directory, use \`pwd\` and \`ls\` (or equivalent) to understand the layout.
- Search before asking: Use search tools to find information in files instead of asking the user immediately.
- Verify assumptions: Don't guess file names or paths; check them first.
`;

export const CLI_OUTPUT_FORMATTING = `
### Communication
- **Silent Tool Execution**: Don't echo tool calls or raw JSON in responses
- **Natural Integration**: Weave findings into conversational narrative
- **Structured Presentation**: Use lists, sections, formatting for clarity. Do not use tables.
- **Actionable Feedback**: Tell user what happened, what it means, what's next
`;
