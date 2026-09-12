---
description: "The Jazz authorization model: risk, disclosure, and egress as independent properties of a tool, and how a caller who is not the operator is bounded."
---

# Jazz security model

Jazz runs model-selected actions as your operating-system user. These controls reduce accidental
and model-induced harm. They do not turn an untrusted model into an OS sandbox.

What they give you is a precise answer to one question. **This caller, on this surface: what can
it reach?**

## Every tool declares three things, and they are independent

Most harnesses have one dial: approved or not. Jazz separates three properties, because
collapsing them loses the cases that actually bite.

| Property       | The question it answers                           |
| -------------- | ------------------------------------------------- |
| **Risk**       | Can running this change something, or cause harm? |
| **Disclosure** | What class of information can its _answer_ carry? |
| **Egress**     | Does calling it send data off this machine?       |

They are independent in both directions, and that is the point:

- `web_search` is read-only and mutates nothing, yet it hands a private query to a third party.
  Risk says "safe", egress says "not without asking".
- `write_file` changes your disk and touches no network. Egress says "safe", risk says "ask".
- `read_file` neither acts nor transmits, but its answer can carry anything on your disk.
  Disclosure is the only axis that sees it.

A single "is this dangerous" flag gets at most one of those three right.

## Who is asking

Two doors on this machine answer somebody who is not you. A **peer** is another agent asking a
question. A **webhook** is an external system firing a fixed prompt. They are the same authorization
question in two wire formats, so they share one model.

**A webhook token holder is a counterparty, not the operator.** The secret authenticates that
webhook, never a person, and it lives in a third party's settings screen: a GitHub repo's webhook
config, an IFTTT applet, a proxy you do not administer.

Treat whoever presents it as owner-equivalent and a leaked field in somebody else's SaaS console
becomes a shell on your machine. Peers get the same treatment, for the same reason.

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

Three consequences worth stating plainly:

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

- [Approvals](./approvals.md) and the [tool lifecycle](../maintainers/tool-lifecycle.md): how a
  call is classified and executed
- [Secrets and egress](./secrets-and-egress.md): keyring, the shell environment scrub, MCP trust
- [Unattended runs](./unattended-runs.md): the checklist before you automate something
- [Surface access](./surface-access.md): authenticating bots, webhooks, the daemon, and peers
- [Threat model](./threat-model.md): the attacks this model does _not_ stop
- [SECURITY.md](../../SECURITY.md): reporting a vulnerability
