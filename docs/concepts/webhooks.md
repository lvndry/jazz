---
description: "What a Jazz webhook is: one authenticated URL bound to one agent and a fixed prompt, the payload quoted as data, each delivery run once, the caller bounded."
---

# Webhooks

A webhook starts an agent when an external system sends an authenticated HTTP request.
Configure its agent and prompt template, then run the [daemon](./daemon.md) to receive requests:

```text
POST /webhooks/<name>  →  agent <agentId> runs <promptTemplate>, with the body quoted in
```

Use a webhook to turn a deployment alert into an incident summary, triage a new issue,
or process an event from your own application. The caller supplies the payload; your
configuration selects the agent, prompt, and tools.

Follow [Create a webhook endpoint](../guides/webhook-endpoint.md) for setup and a test request.

## Payload handling

The request body arrives inside the prompt explicitly marked as untrusted, the same treatment
`web_fetch` output and a peer's reply get. `{{payload}}` in the template says where it lands;
without the placeholder it is appended at the end.

Payload framing reduces prompt-injection risk but does not replace tool restrictions.
Grant only the tools the event handler needs.

## Proving who sent it

A webhook authenticates one of two ways:

- **A bearer token** (`jazz webhook token <name>`), sent as `Authorization: Bearer <token>` on
  every request. Right for a caller you control.
- **A signature** over the raw body, for a service that signs its deliveries. Set
  `"signature": { "format": "hmac-sha256" }` and mint the shared secret with
  `jazz webhook secret <name>`. The defaults read GitHub's `X-Hub-Signature-256: sha256=<hex>`;
  `signature.header` and `signature.prefix` change them. The secret never travels, so seeing a
  delivery does not let anyone forge the next. A signed webhook ignores `Authorization`.

Either way, an unknown webhook name gets the same `401` as a bad credential, so nobody can list
your webhooks by guessing names.

**Each delivery runs once.** Jazz remembers the last deliveries of each webhook on disk, by the
sender's delivery id (`X-GitHub-Delivery`, or the header `deliveryIdHeader` names) and, when the
webhook is signed, by signature. GitHub does not sign its delivery id, so the signature is what
makes a captured request useless under a new id. A repeat answers `409` and runs nothing.

## Request permissions and limits

Webhook requests use the permissions you configured for that endpoint:

`disclosure` caps what an answer may reveal. It defaults to `internal`: read-only tools that
describe the shape of the machine, but not the contents of your files.

`allow` names the tools that may act or send data off the machine, at any tier. An unnamed tool
is absent from the run, not queued for an approval nobody is there to give.
[The security model](../security/index.md) has the full rule.

The run gets none of your own context either: no standing preferences from memory, no AGENTS.md,
and no local file attached because the payload names a path.

`budget` caps each run
(`{ "maxTokens": 50000, "maxCostUSD": 0.1, "maxDurationMs": 120000 }`, each optional, falling
back to your app-wide caps), and `maxConcurrentRuns` (default 4) caps how many run at once; past
it the endpoint answers `429` with `Retry-After`. Bodies over 1 MiB are refused while they stream.

A run that parks on an approval keeps its boundary: when you approve it, it resumes with the same
tool list, still without your context, and with only the budget it had left.

A failed run answers `{ "ok": false, "error": "the run failed" }`. The cause goes to the daemon's
log.

## One-shot or threaded

`ephemeral`, the default, starts each fire from nothing. Use it for events that should be handled independently.

`threaded` resumes instead. Fires carrying the same `X-Jazz-Thread` value continue one
conversation, so an agent relaying an exchange is not re-told its own history every turn. Each
webhook's threads are its own: no thread key sent to one webhook can reach another's history.

An ephemeral webhook refuses requests with a thread key.

## Webhook or peer

- A **webhook** exposes one fixed prompt to an external system. The contract is an event shape.
- A **[peer](./agent-to-agent.md)** accepts open-ended questions from one authenticated agent.

Use a webhook when the caller only needs to send events to a fixed prompt.

## Related

- [Wake an agent from another system](../guides/webhook-endpoint.md): build one end to end,
  including a GitHub webhook behind a proxy
- [Configuration](../configure/jazz.md): where webhook definitions live
- [`jazz webhook`](../commands.md): minting and forgetting tokens and signing secrets
- [Surface access](../security/surface-access.md): before you expose the daemon
