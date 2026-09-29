---
description: "The Jazz authorization model: risk, disclosure, and egress as independent properties of a tool, and how a caller who is not the operator is bounded."
---

# Jazz security model

Jazz runs model-selected actions as your operating-system user. These controls reduce accidental
and model-induced harm. They do not turn an untrusted model into an OS sandbox.

Start with [Approvals](./approvals.md) for terminal use, [Unattended runs](./unattended-runs.md)
for automation, or [Surface access](./surface-access.md) before exposing an agent remotely.

## Tool permissions

Jazz controls tool execution, access to information, and network requests separately.

| Property       | The question it answers                           |
| -------------- | ------------------------------------------------- |
| **Risk**       | Can running this change something, or cause harm? |
| **Disclosure** | What class of information can its _answer_ carry? |
| **Egress**     | Does calling it send data off this machine?       |

For example:

- `web_search` is read-only but sends the query to your search provider.
- `write_file` changes your disk without sending data over the network.
- `read_file` does not change a file, but can reveal its contents.

## Who is asking

A **peer** is another agent asking a question. A **webhook** is an external system
firing a fixed prompt. Configure each caller's disclosure tier, allowed tools, and budgets.

**A webhook token holder is a counterparty, not the operator.** The secret authenticates that
webhook, never a person, and it lives in a third party's settings screen: a GitHub repo's webhook
config, an IFTTT applet, a proxy you do not administer.

Caller runs receive no standing preferences, AGENTS.md instructions, or file attachments
from paths in their prompts. They retain their budgets and tool restrictions after approval
and resume.
[Surface access](./surface-access.md#webhooks-and-peers) has the details.

## How the ceiling is computed

A caller holds a **disclosure tier** and an **allow list**, and they do different jobs:

```text
tool is read-only AND non-egress  →  admitted if its disclosure fits the tier
anything else                     →  admitted only if named in `allow`
```

| Tier       | Admits read-only, non-egress tools whose answers are…          |
| ---------- | -------------------------------------------------------------- |
| `none`     | nothing at all. This is what revoking a caller sets            |
| `public`   | nothing about you or your machine                              |
| `internal` | + paths, names, what is installed. Not file contents           |
| `private`  | + your own material, still read-only. The most any caller gets |

The following restrictions apply:

- **Raising the tier never grants an acting tool.** Disclosure is silent about damage, so
  `execute_command` is not admitted at `private`. It is admitted by being named, at any tier.
- **An unlisted tool is absent, not unapproved.** It is left out of the toolset, so the model is
  never offered it. Nothing outside the list for an injected payload to talk its way into, and no
  approval prompt for an unattended run to hang on.
- **Revocation is total.** Set a caller to `none` and a standing `allow` grant does not survive
  it. An unrecognized tier lands in the same place, so a typo fails closed.

## Where each control lives

| Control                        | Set on                                                                     |
| ------------------------------ | -------------------------------------------------------------------------- |
| Which tools exist at all       | the agent. `tools` adds, `deniedTools` subtracts last                      |
| Disclosure and `allow`         | the caller. Each peer, each webhook                                        |
| What runs without asking       | the run. Approval policy, plus a per-command verdict for `execute_command` |
| What happens with nobody there | the surface. Decline, or `--park` and resume after a person answers        |

## Read next

- [Approvals](./approvals.md): what runs without asking
- [Secrets and egress](./secrets-and-egress.md): keyring, the shell environment scrub, MCP trust
- [Unattended runs](./unattended-runs.md): the checklist before you automate something
- [Surface access](./surface-access.md): authenticating bots, webhooks, the daemon, and peers
- [Threat model](./threat-model.md): the attacks this model does _not_ stop
- [SECURITY.md](../../SECURITY.md): reporting a vulnerability
