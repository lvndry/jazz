---
description: "Connect separately operated Jazz agents through explicit peer identities, invite-based authentication, disclosure ceilings, and receiving-side tool policies."
---

# Agent-to-agent peers in Jazz

A peer is another Jazz agent this installation has explicitly chosen to trust. Peers exchange open-ended requests over the Agent2Agent protocol.

## Trust model

Peer discovery does not create trust. A peer must be configured or accepted through an invite flow. Credentials are stored separately from peer metadata and must not appear in URLs, logs, or prompts.

The receiving installation remains authoritative. It selects its own agent, model, tools, disclosure ceiling, approval policy, and conversation behavior. A caller cannot lend its permissions to the receiver.

## Peer versus webhook

- A webhook exposes one fixed prompt template to an external system.
- A peer accepts open-ended requests from one authenticated agent identity.

Use the narrower webhook boundary when a fixed event contract is sufficient.

## Start

`jazz peers` manages known peers and invite flows. The [daemon](./daemon.md) serves peer requests. Follow [Connect two Jazz agents](../guides/connect-peers.md) for localhost, tailnet, and internet-facing setups.
