---
description: "Expose a Jazz agent through an authenticated fixed-prompt HTTP endpoint with explicit conversation, disclosure, and tool limits."
---

# Webhooks in Jazz

A webhook is an authenticated HTTP door served by the [daemon](./daemon.md). It binds a URL name to one agent and one prompt template.

Incoming request data is quoted into the template as data. The caller does not choose the agent or replace the surrounding instructions. A webhook may further limit disclosure and allow only named tools beyond that ceiling.

Use ephemeral conversation mode when events are independent. Use threaded mode when repeated deliveries with the same thread key should share history.

Webhook definitions live in Jazz configuration; bearer tokens are managed separately with `jazz webhook` and should remain in the system keyring.

Build one end to end in [Wake an agent from another system with a webhook](../guides/webhook-endpoint.md).

Choose a webhook for structured events from another application. Choose a [peer](./agent-to-agent.md) when another trusted agent needs to ask open-ended questions. See [Surface access](../security/surface-access.md) before exposing the daemon beyond localhost.
