---
description: "Understand Jazz tool permissions, approval policies, unattended execution, secret handling, data disclosure, network egress, and trust boundaries."
---

# Jazz security model

Jazz runs model-selected actions as your operating-system user. Its controls reduce accidental or model-induced harm; they do not turn an untrusted model into an operating-system sandbox.

## The security layers

1. **Capability selection:** an agent only receives tools resolved for its persona and configuration. Explicit denials are applied last.
2. **Disclosure limits:** a caller can restrict which data classes a tool may reveal.
3. **Egress limits:** outbound tools are identified separately from read-only local tools.
4. **Risk classification:** tools declare a risk level; shell commands receive a command-specific verdict.
5. **Approval policy:** the run decides which risk levels execute automatically and which require a person.
6. **Unattended behavior:** a run without an interaction channel declines gated work or parks explicitly; it does not wait invisibly.
7. **Secret handling:** credentials use the keyring when available, sensitive environment variables are removed from shell execution, and logs must not contain secrets.
8. **Surface authorization:** bots, webhooks, daemon endpoints, and peers authenticate callers before starting a run.

## Start with the boundary you are exposing

- For tool execution, read [Tools and approval](../maintainers/tool-lifecycle.md).
- For remote entry points, read [Chat surfaces](../surfaces/chat.md), [Webhooks](../concepts/webhooks.md), and [Peers](../concepts/agent-to-agent.md).
- For attack surfaces and non-goals, read the [threat model](./threat-model.md).
- For vulnerability reporting and deployment hardening, read [SECURITY.md](../../SECURITY.md).

## Least privilege in practice

Give an agent the smallest toolset that completes its job, deny capabilities it should never receive, use the lowest workable approval policy, isolate unattended deployments with operating-system or container controls, and scope credentials to the service and account the agent actually needs.
