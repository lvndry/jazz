---
description: "Build distinctive Jazz agents: a self-hosted CI reviewer, reusable accountability persona, research automation, chat agent, and trusted peers."
---

# Jazz guides

These are complete jobs, not prompt galleries. Each guide combines Jazz features into something useful and shows the security boundary before moving work unattended.

## Start with what is distinctive about Jazz

- [Review pull requests in CI with OpenRouter or your own model](./pr-review.md): run a multi-agent reviewer in GitHub Actions, validate its line comments, and keep posting credentials outside the model's toolset.
- [Investigate an attack and approve a Cloudflare WAF rule](./contain-cloudflare-attack.md): let independent agents test competing explanations, then require a responder to approve the exact production containment action.
- [Build a multi-agent verification council](./multi-agent-verification.md): give independent subagents bounded review questions, validate their result shapes, and make the parent reconcile the evidence.
- [Build a reusable accountability persona named Goggins](./goggins-accountability-agent.md): define behavior once, attach it to an agent, then use the same identity interactively, from a script, or on a schedule.
- [Turn incident evidence into a visual briefing](./media-companions.md): let specialist models inspect screenshots, recordings, and video, then use a generation companion for the final artifact.
- [Connect two Jazz agents as peers](./connect-peers.md): let separately deployed, explicitly trusted agents ask each other for help.
- [Wake an agent from another system with a webhook](./webhook-endpoint.md): bind one authenticated URL to one agent and one prompt, and bound what the caller can reach.

## More complete examples

- [Deploy a chat agent](./deploy-a-chat-agent.md)
- [Run inbox triage](./inbox-triage.md)
- [Build a weekly multi-agent research radar](./research-digest.md)

A guide belongs here only when its commands and configuration are maintained. Short prompt ideas belong on the [features](../features/index.md) page, not in separate documentation files.

## Tutorial pipeline

These combinations deserve the same end-to-end treatment next:

- **Cross-boundary engineering team:** let a personal planning agent consult a company-hosted code agent without copying repository credentials or private files between them.
- **Small-model escalation ladder:** run the routine path on a local model, delegate specialist checks, and ask a peer backed by a stronger model only when verification fails.
- **Memory-scoped support agent:** share product memory across channels while keeping each customer's conversation and private facts isolated.
