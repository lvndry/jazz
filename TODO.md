# Jazz TODO

## CLI & User Experience

- [x] Make reasoning tokens visible.
- [x] Stream content in terminal — swap to `streamText` to present incremental LLM output and reduce
      perceived latency.
- [x] Update system prompt to discorourage usage of tables. They don't render well in terminal
- [x] Better colors and theme.
- [x] Finish implementation `jazz config` command similar to `git config` where we can inline change jazz config
- [x] Being able to switch agents while in the same conversation using `/switch` command. This would allow to switch to a
      more capable or less costly model while keeping the same context
- [x] Easy update - `jazz update`

## Agent Runtime & Automation

- [ ] Dynamic tool loading - dynamically load only relevant tools based on context/user query
- [ ] Being able to always approve low stake tools - Give a risk level to tools, being able to say if we want to allays authorize a tool so that it don't ask for approval every time
- [x] Summarize context near window limits — add automatic context compression that preserves action
      history when tokens spike.
- [ ] Explore sub-agent triggers — PoC orchestration primitives.
- [ ] Trigger system (schedule, file, webhook, manual) — hooks/cronjobs. Might require being able to execute jazz tasks
- [ ] Memory architecture — define long-term memory (storage, schema, retrieval) for
      agent personalization.
- [x] Skills - Similar to Claude Skills, but for Jazz
- [ ] When editing a file, part of the output should be the diff of the file

## CLI Feature Depth & Docs

- [x] Cookbooks with concrete agent workflows — publish scenario-driven recipes (deployments, inbox
      triage, reporting)

## Integrations

- [x] Google Calendar tools
  - [x] Events for the day
  - [x] Create/Delete event
  - [x] Edit event
- [ ] Gmail enhancements
  - [ ] Attachment support — wire interface implementation for upload/download streams.
  - [ ] `createReplyToEmailTool` — reply within thread while preserving references and history.
  - [ ] `createForwardEmailTool` — forward with original metadata and optional redaction.
  - [ ] Advanced search with date ranges — accept structured filters and map to Gmail query
        language.
- [x] Ollama - Being able to pass custom baseURL in config
- [x] Ollama - Fetch available models from baseURL instead of keeping a list of static model
- [x] Notion tools (Available via MCP)

## Quality, Safety & Testing

- [ ] Security tests — build suites covering command injection, privilege escalation, sandbox
      escapes, and malicious tool payloads.
- [ ] More unit tests

## Developer experience

- [ ] Precommit hooks

## Ideas & Research

- [Explorations](./docs//exploration/)
- Per-agent authentication domains to isolate credentials (support multiple Gmail accounts, etc.).
- Rich workflow memory tuned to personal preferences (favorite folders, project contexts, historical
  decisions).
- Agent evaluations - When system prompt is evolving, users could create a bunch of tests to be run
  in a sandbox and evaluate the output. Evals could be executed in a sandbox (docker container), we
  could then evaluate the outcome and the tools/used and suggest improvements to the prompts for
  better/faster task completion

## Workflow Concepts To Validate

- [x] Read repo diff, propose commit message, then commit & push automatically. ->
- [x] Summarize emails labeled `newsletter` and bulk archive/delete on confirmation.
- [x] Clone a repository from a URL, follow setup instructions, and report completion status.
