---
description: "Authenticate and isolate remote Jazz agent surfaces including chat bots, webhook endpoints, the daemon, and agent-to-agent peers."
---

# Secure Jazz bots, webhooks, daemon endpoints, and peers

Every remote surface must answer three questions: who may start a run, which conversation do they resume, and what may that run disclose or execute?

- **Chat bots** apply platform-specific allowlists and map each allowed chat to isolated conversation state.
- **Webhooks** use bearer tokens and fixed prompt templates. Per-webhook disclosure and tool allowlists narrow the exposed capability.
- **Daemon endpoints** require the daemon token and exist to submit or resume work; do not expose the daemon directly to the public internet.
- **Peers** are explicitly configured identities. Invite redemption establishes credentials but does not make arbitrary discovered agents trusted peers.

Put internet-facing processes behind TLS and a reverse proxy, bind locally when remote access is unnecessary, rotate credentials after suspected exposure, and run the bridge with fewer operating-system privileges than your personal account.
