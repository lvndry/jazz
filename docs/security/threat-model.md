---
description: "The Jazz threat model: the failures its approval, disclosure, egress, secret, daemon, webhook, peer, and isolation controls address, and their limits."
---

# Jazz threat model

Jazz runs model-selected actions as the operating-system user that started it. The harness is
designed to constrain mistakes, prompt injection, over-broad integrations, and unauthenticated
remote callers. It is not a sandbox against a hostile model, compromised dependency, or operator.

## Assets and boundaries

The assets at risk are local files, repository state, credentials, conversation history, model
budget, connected services, and information returned to a remote caller. The relevant boundaries
are independent:

- **Model provider:** receives prompts and attachments sent for inference.
- **Tool execution:** can read, mutate, or transmit data with the Jazz process's authority.
- **MCP and custom tools:** run third-party or deployment-authored code.
- **Plugins:** explicitly trusted in-process modules run with the Jazz process's full OS authority;
  their manifests describe expected use but do not confine code.
- **Remote surfaces:** bots, daemon clients, webhooks, invites, and peers decide who can start work.
- **Persistence:** config, transcripts, work state, logs, and telemetry remain readable to the OS
  account unless the host provides stronger isolation.

## Controls Jazz enforces

### Capability before approval

An unavailable tool cannot be approved. Jazz resolves the built-in bundle, persona profile, agent
additions, MCP/custom tools, and then applies `deniedTools` and any run-specific allowlist. Use
`deniedTools` for a hard per-agent ceiling; `tools` is additive, not an allowlist.

Available mutating tools use approval pairs: the proposal describes the action, then only the hidden
execution half performs it. `execute_command` is classified per command because its declared risk is
`unknown`. An enabled `classify.command-risk` policy hook may supply that classification and can
therefore affect whether the active tier asks for approval. It cannot classify statically rated
tools, expand the effective tool set, override allowlists or the selected tier, or bypass the shell
denylist. Plugin failure falls back to the built-in classifier; unknown or ambiguous shell commands
remain `high-risk`. The denylist is only defense in depth and is bypassable by obfuscation.

Interactive runs ask a person. Unattended runs auto-approve only what their policy admits and decline
the rest. `--park` is an explicit alternative that persists one waiting run for later approval.

### Disclosure and egress

Risk, disclosure, and egress are separate metadata. A read-only web request can transmit private
text; a local file edit mutates without egress. Webhook and peer runs first enforce a disclosure
ceiling and remove egress tools, then add only tools explicitly named in that caller's `allow` list.
The receiving installation chooses its agent and policy; a peer cannot import the caller's authority.

A network-backed command-risk plugin is a separate egress boundary. Jazz projects only the bounded
command string into `classify.command-risk`; it does not include conversation history, tool results,
environment variables, or file contents. The manifest must declare command-text egress and the exact
destination, and a local operator must consent to those declarations for the current code digest.

### Secrets

Secrets resolve from environment variables, then the OS keyring, then a mode-`0600` local config
fallback when no keyring is usable. Shell children lose variables whose names look credential-bearing
and all `SSH_*` variables unless an exact valid name appears in the agent's `envAllowlist`. Log and
telemetry serializers redact known credential fields. Routine INFO/ERROR logs and shared telemetry
events omit command text, tool arguments, results, and prompt/completion text. The local tool audit
record keeps a bounded argument shape; transcripts and other local records remain sensitive plaintext.
Pending OTLP traces and logs are stored in a private, bounded outbox until delivery or expiry.

### Remote entry points

`jazz run` listens on no port. `jazz daemon` binds loopback by default and provisions an operator
token on first start, including on loopback. If token storage is deliberately disabled and no token
is supplied, a loopback daemon warns and may run without one; a non-loopback bind refuses.

Operator HTTP routes reject browser `Origin` headers, and JSON routes require
`application/json`, reducing drive-by browser access to a loopback daemon. This does not protect
against another local process that already has the operator token.

Peers authenticate with separate per-peer tokens. Webhooks use per-door tokens and fixed prompt
templates. Invite secrets are one-time credentials. Telegram, Discord, iMessage, Photon, and
WhatsApp bridges apply their own sender or conversation allowlists before a run starts.

## What Jazz does not guarantee

- **Prompt-injection immunity:** hostile content can steer actions already permitted by the toolset
  and active policy.
- **Host isolation:** a shell-capable agent can reach whatever its OS user and network can reach.
- **Third-party correctness:** an MCP server, custom command, model provider, or chat transport may
  mishandle data after it crosses that boundary.
- **Plugin isolation or preemption:** a trusted plugin can bypass its declared projection, network,
  and secret API; synchronous code can block or terminate Jazz. Cooperative timeouts and disabling
  stop host dispatch, not code that has already escaped host control.
- **Classifier correctness:** an explicitly trusted and consented command-risk plugin can
  misclassify an eligible `execute_command` call. Jazz validates its shape, limits its scope, and
  fails closed on operational errors, but probabilistic judgment is not proof of safety.
- **Air gap from `JAZZ_OFFLINE`:** the flag skips public catalog, library, and update requests;
  it does not block inference, tools, MCP, or OTLP. Enforce egress outside Jazz.
- **Encrypted local history:** transcripts, work state, logs, and local telemetry are files under
  the Jazz data directory.
- **Exact budget preemption:** iteration, token, cost, and duration budgets are checked between
  iterations, so one in-flight call may cross a limit.

## Deployment checklist

Before exposing an unattended agent:

1. Remove tools the job cannot need and test the effective list.
2. Use the lowest approval policy that completes the expected path.
3. Scope provider and service credentials to a dedicated account.
4. Isolate the process with a dedicated OS user, container, and outbound network policy.
5. Authenticate and allowlist the actual caller identity; do not treat a public URL as identity.
6. Bound iterations, time, tokens, and cost, then test failure and provider-unavailable paths.
7. Protect `$JAZZ_HOME` as sensitive data and configure OTLP only to an approved collector.

Implementation paths and regression tests are linked from [Tools and approval](../maintainers/tool-lifecycle.md),
[Surface access](./surface-access.md), [Secrets and egress](./secrets-and-egress.md), and
[SECURITY.md](../../SECURITY.md).
