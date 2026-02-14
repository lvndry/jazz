# Jazz TODO

## CLI & User Experience

## Agent Runtime & Automation

- [ ] **Conversation-end refinement**: At session end, agent extracts and
      stores useful context revealed during the conversation (e.g. user's
      Obsidian vault path, preferred tools/configs, workflow preferences).
      Injected into future sessions when relevant.
- [ ] Being able to queue user messages

## CLI Feature Depth & Docs

- [x] Cookbooks with concrete agent workflows — publish scenario-driven recipes (deployments, inbox triage, reporting)

## Quality, Safety & Testing

- [ ] Security tests — build suites covering command injection, privilege escalation, sandbox escapes, and malicious tool payloads.

## Developer experience

- [ ] Precommit hooks

## Ideas & Research

- [Explorations](./docs//exploration/)
- Per-agent authentication domains to isolate credentials (support multiple Gmail accounts, etc.).
- Rich workflow memory tuned to personal preferences (favorite folders, project contexts, historical decisions).
- Agent evaluations - When system prompt is evolving, users could create a bunch of tests to be run in a sandbox and evaluate the output. Evals could be executed in a sandbox (docker container), we could then evaluate the outcome and the tools/used and suggest improvements to the prompts for better/faster task completion
