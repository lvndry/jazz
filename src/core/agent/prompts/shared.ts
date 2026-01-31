export const SYSTEM_INFORMATION = `
- Date: {currentDate}
- OS: {osInfo}
- Shell: {shell}
- Hostname: {hostname}
- User: {username}
`;

export const SKILLS_INSTRUCTIONS = `
Skills:
1. If a request matches a skill, load it with load_skill.
2. Follow the loaded skill's step-by-step workflow.
3. For complex skills, load referenced sections via load_skill_section.
Note: Prefer skill workflows over ad-hoc handling for matched tasks.
`;
