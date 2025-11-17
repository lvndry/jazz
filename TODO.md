# Jazz TODO

## CLI & User Experience

- [->] Make reasoning tokens visible.
- [->] Stream content in terminal — swap to `streamText` to present incremental LLM output and
  reduce perceived latency.
- [ ] Reduce length of system prompt.
- [ ] Better colors and themes.
- `jazz config` command similar to `git config` where we can inline change jazz config

## Agent Runtime & Automation

- [ ] Summarize context near window limits — add automatic context compression that preserves action
      history when tokens spike.
- [ ] Explore sub-agent triggers — design trigger taxonomy (event, schedule, manual) and PoC
      orchestration primitives.
- [ ] Trigger system (schedule, file, webhook, manual) — implement unified trigger dispatcher with
      persistence and retry policies.
- [ ] Memory architecture — define long-term memory spec (storage backend, schema, retrieval) for
      agent personalization.
- [ ] Skills management — build discovery/registration mechanism so agents can opt into capabilities
      with explicit contracts.
- [ ] Dynamic tool loading - dynamically load only relevant tools based on context/user query
- [ ] Being able to always approve low stake tools - Give a risk level to tools, being able to say
      if we want to allays authorize a tool so that it don't ask for approval every time
- [ ] Being able to switch agents while in the same conversation. This would allow to switch to a
      less costly model or more complex model while keeping the same context window

## CLI Feature Depth & Docs

- [ ] Improve `jazz agent create` ergonomics — expand flags (tools, schedule, auth) and inline help;
      document the flow with examples like
      `jazz agent create --name "deploy-master" --tools git,files`.
- [ ] Cookbooks with concrete agent workflows — publish scenario-driven recipes (deployments, inbox
      triage, reporting) with reusable configs.

## Integrations

- [ ] Google Calendar tools
  - [ ] Events for the day
  - [ ] Create/Delete event
  - [ ] Edit event
- [ ] Gmail enhancements
  - [ ] Attachment support — wire interface implementation for upload/download streams.
  - [ ] `createReplyToEmailTool` — reply within thread while preserving references and history.
  - [ ] `createForwardEmailTool` — forward with original metadata and optional redaction.
  - [ ] Advanced search with date ranges — accept structured filters and map to Gmail query
        language.
  - [ ] Calendar integration bridge — parse meeting intents and invoke Calendar tooling once
        available.
  - Add more ready to use agent with specific set of tools ans skills - code agent, fs agent, ...

## Quality, Safety & Testing

- [ ] Security tests — build suites covering command injection, privilege escalation, sandbox
      escapes, and malicious tool payloads.
- [ ] Broaden automated test coverage — prioritize Effect-based unit tests for CLI commands, tool
      adapters, and runtime layers.
- [ ] readFile tool should only read files 100 lines per 100 lines to avoid loading large files into
      memory all at once

## Developer experience

- [ ] Precommit hooks
- [ ] Easy update - `jazz update`

## Backlog Ideas & Research

- Config-driven agent provisioning, e.g. `jazz agent create --config agent.json`.
- Per-agent authentication domains to isolate credentials (support multiple Gmail accounts, etc.).
- Rich workflow memory tuned to personal preferences (favorite folders, project contexts, historical
  decisions).
- Agent evaludation - When system prompt is evolving, users could create a bunch of tests to be run
  in a sandbox and evaluate the output. Evals could be executed in a sandbox (docker container), we
  could then evaluate the outcome and the tools/used and suggest improvements to the prompts for
  better/faster task completion

## Workflow Concepts To Validate

- Read repo diff, propose commit message, then commit & push automatically.
- Summarize emails labeled `newsletter` and bulk archive/delete on confirmation.
- Download an image from a given URL into a specified local workspace folder.
- Clone a repository from a URL, follow setup instructions, and report completion status.
