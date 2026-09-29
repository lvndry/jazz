---
description: "Build an authenticated HTTP door that wakes one Jazz agent with a fixed prompt, test it with curl, then point a real GitHub webhook at it."
---

# Wake an agent from another system with a webhook

Create an authenticated issue-triage webhook, test it with `curl`, then connect it
to GitHub. The webhook uses a fixed prompt and agent, with limits on tools and spend.

## How requests run

One URL name bound to one agent and one prompt template, served by `jazz daemon`:

```text
POST /webhooks/<name>  →  agent <agentId> runs <promptTemplate>, with the body quoted in
```

The caller chooses **nothing** except the payload. Not the agent, not the prompt, not the
tools. The payload arrives inside the prompt between two fence lines drawn at random for each
fire, so it cannot close the fence early and write text that reads as yours. It is data, never
spliced in as an instruction, the same treatment `web_fetch` output and a peer's reply get.

The run also gets none of your own context: no standing preferences from memory, no AGENTS.md,
and no file attached because the payload names a path on your machine.

Use a [peer](../concepts/agent-to-agent.md) for open-ended requests between agents.

## 1. Pick the agent

Any agent will do. Create one if you have none:

```bash
jazz agent create
```

Name it `triage`. Its model and persona are yours to choose; the webhook does not change them.

## 2. Define the door

Webhooks live in `~/.jazz/config.json` under `webhooks`. Add one:

```json
{
  "webhooks": [
    {
      "name": "issue-triage",
      "agentId": "triage",
      "description": "GitHub issues:opened, first-pass triage",
      "promptTemplate": "A GitHub issue was just opened. From the payload below, reply with exactly three lines: SEVERITY (low/medium/high), AREA (one word), and SUMMARY (one sentence a maintainer can act on). If the payload is not an issue event, reply 'ignored'.\n\n{{payload}}",
      "conversation": "ephemeral",
      "disclosure": "internal"
    }
  ]
}
```

Required fields and disclosure:

| Field            | What it decides                                                                      |
| ---------------- | ------------------------------------------------------------------------------------ |
| `name`           | The URL (`/webhooks/issue-triage`) and which credential unlocks it                   |
| `agentId`        | Which agent wakes, by id or by name                                                  |
| `promptTemplate` | The entire instruction. `{{payload}}` is where the body lands, quoted as data        |
| `disclosure`     | The ceiling on what the run may reveal. Defaults to `internal` when you leave it out |

Four more are optional and bound what one sender can cost you:

| Field               | What it decides                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `signature`         | Authenticate by a signature over the body instead of a bearer token. See [step 6](#6-point-github-at-it)             |
| `deliveryIdHeader`  | The header naming each delivery, so a repeat runs nothing. Defaults to GitHub's `X-GitHub-Delivery`                  |
| `budget`            | `maxTokens`, `maxCostUSD` and `maxDurationMs` for each run this door starts, including one resumed after an approval |
| `maxConcurrentRuns` | How many runs may be in flight at once. Defaults to 4; past it the door answers `429` with `Retry-After`             |

Leave `{{payload}}` out and the payload is appended at the end instead, with the same quoting
and less control over where it sits.

Specify the response format in `promptTemplate` if the caller needs to parse it.

## 3. Mint the token

Each door carries its own credential. For a caller you control, like the `curl` below, that is
a bearer token. Jazz generates it, stores it in the OS keyring, and prints it exactly once:

```bash
jazz webhook token issue-triage
```

Copy the value now. If you lose it, run the command again to mint a new one, which overwrites
the old. On a host with no keyring (a container), set
`JAZZ_WEBHOOK_TOKEN_ISSUE_TRIAGE` in the daemon's environment instead.

The token never goes in `config.json`. It authenticates _this webhook_, not you. See
[what the caller can reach](#what-the-caller-can-and-cannot-do) for why that distinction
decides the tool ceiling.

## 4. Serve it

```bash
jazz daemon
```

`/webhooks/` is served on every daemon; no flag turns it on. The default is
`http://127.0.0.1:4747`, loopback-only. A webhook added while the daemon is running works on
the next request, because the list is read per call. There is nothing to restart.

## 5. Fire it

```bash
curl -X POST http://127.0.0.1:4747/webhooks/issue-triage \
  -H "Authorization: Bearer $JAZZ_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"opened","issue":{"number":412,"title":"Timeouts on /export since 2.3.0","body":"Every export over ~50MB now 504s. Worked on 2.2.9."}}'
```

The request is held open until the run finishes, then answers:

```json
{
  "ok": true,
  "answer": "SEVERITY: high\nAREA: export\nSUMMARY: Exports over ~50MB began returning 504 in 2.3.0 and worked in 2.2.9, so a regression in the export path needs bisecting between those releases.",
  "costUSD": 0.0041
}
```

`costUSD` is there so a caller can budget on spend rather than request count. When a price is
unknown, `costIncomplete: true` rides alongside it rather than being folded in, so the figure is
then a floor rather than a total.

## 6. Point GitHub at it

The daemon binds loopback by default, which GitHub cannot reach. Give it a public address
first, a tunnel for a trial or a reverse proxy with TLS for anything lasting, and read
[Surface access](../security/surface-access.md) before you bind anything but `127.0.0.1`.

GitHub cannot send a bearer token. It signs every delivery instead: an HMAC-SHA256 of the body
under a secret you share, in `X-Hub-Signature-256`. The secret itself never travels, so anyone
who sees a delivery still cannot forge the next one. Tell the webhook to expect it:

```json
{
  "name": "issue-triage",
  "agentId": "triage",
  "promptTemplate": "...",
  "signature": { "format": "hmac-sha256" }
}
```

Then mint the secret. Like the token, it goes to the OS keyring and is printed once:

```bash
jazz webhook secret issue-triage
```

In a container, set `JAZZ_WEBHOOK_SECRET_ISSUE_TRIAGE` in the daemon's environment instead.

In the repository's **Settings → Webhooks → Add webhook**:

- **Payload URL:** `https://<your-host>/webhooks/issue-triage`
- **Content type:** `application/json`
- **Secret:** the value `jazz webhook secret` printed
- **Events:** _Let me select individual events_ → **Issues**

A webhook with a `signature` ignores any `Authorization` header, and a body whose signature does
not match, or that arrives with none, gets `401`. Do not have the proxy add a bearer token: a
proxy that attaches the credential to every request forwards anyone's request as authenticated.

Once the webhook has a `signature`, the bearer token from step 3 no longer opens it. To test it
with `curl`, sign the body the way GitHub does:

```bash
body='{"action":"opened","issue":{"number":412}}'
signature=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$JAZZ_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST http://127.0.0.1:4747/webhooks/issue-triage \
  -H "X-Hub-Signature-256: sha256=$signature" \
  -H "Content-Type: application/json" \
  -d "$body"
```

Other senders sign the same way under different names. `signature.header` and
`signature.prefix` change where Jazz looks, for example
`{ "format": "hmac-sha256", "header": "x-signature", "prefix": "" }` for a bare hex digest.

**Each delivery runs once.** Jazz remembers the last deliveries per webhook on disk, by
`X-GitHub-Delivery` (or your `deliveryIdHeader`) and by signature. GitHub does not sign its
delivery id, so the signature is what stops a captured request from being replayed under a new
one. A repeat answers `409` and runs nothing. That includes GitHub's **Redeliver** button: to run
an event again, trigger a new one.

## Threaded doors, for an ongoing exchange

`ephemeral` (the default) starts each fire from nothing: right for isolated events, where
remembering the last deploy buys you nothing. When deliveries are turns in one conversation, a
support thread or a chat relay, make the door `threaded` and tell it which thread each fire
belongs to:

```json
{
  "name": "support-relay",
  "agentId": "support",
  "promptTemplate": "Reply to the customer message below. {{payload}}",
  "conversation": "threaded"
}
```

```bash
curl -X POST http://127.0.0.1:4747/webhooks/support-relay \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Jazz-Thread: ticket-8812" \
  -d 'The refund still has not arrived.'
```

Same `X-Jazz-Thread` value, same conversation, so the agent remembers what was already said.
Sending a thread key to an `ephemeral` door returns `400`.

The key is at most 200 characters. Fires with no key share one conversation rather than
getting a fresh one each time, so a threaded door never silently behaves like an ephemeral one.

## Watching a long run

A webhook is one held-open request, so a turn that reads a calendar and searches the web is
minutes of silence. A caller with somewhere to listen can say so:

```bash
curl -X POST http://127.0.0.1:4747/webhooks/issue-triage \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Jazz-Progress-Url: http://127.0.0.1:9099/progress" \
  -H "X-Jazz-Progress-Events: tool-started,tool-finished" \
  -d '{"action":"opened","issue":{"number":412}}'
```

Jazz `POST`s each event as JSON to that URL while the run goes, then answers the original
request as usual. The kinds are `tool-started`, `tool-finished`, and `approval-required`;
omit the header to get all three. An invalid event kind returns `400`.

The progress URL must be loopback.

## What the caller can and cannot do

A webhook token lives in somebody else's settings screen: a GitHub repo's webhook config, an
IFTTT applet, a proxy. You do not administer that place and cannot audit it. So Jazz treats
the holder as an external counterparty, never as you, and bounds the run on two independent
axes:

- **`disclosure`** is a ceiling on what an answer may _reveal_. `internal` (the default) is
  read-only tools that describe the shape of the machine (what exists, what is installed, what
  the web says) but not the contents of your files or your memory. `public` is less,
  `private` is the most an external caller can ever hold, and `none` reaches nothing.
- **`allow`** is the separate question of _damage_. Disclosure says nothing about acting, so a
  tool that can act is admitted only by being named here, at any tier:

  ```json
  {
    "name": "deploy-notify",
    "agentId": "release",
    "promptTemplate": "A deploy finished. Post a one-line summary to the team. {{payload}}",
    "disclosure": "internal",
    "allow": ["send_slack_message"]
  }
  ```

Tools outside the effective list are unavailable to the run.

If the run does reach something needing approval, the fire returns `202` with a run id rather
than hanging:

```json
{ "ok": false, "state": "input-required", "runId": "run_01H...", "pending": "..." }
```

Approve it yourself later with `jazz runs approve <runId>`, or leave those tools out. The run
resumes inside the same boundary it parked in: the same tool list, no operator context, and
only the budget it had left.

**What one sender can cost you.** Without a `budget`, a webhook's runs fall back to your
app-wide `maxTokens`, `maxCostUSD` and `maxDurationMs`, which are unset by default.
Set a separate limit for each webhook:

```json
{
  "name": "issue-triage",
  "budget": { "maxCostUSD": 0.05, "maxDurationMs": 120000 },
  "maxConcurrentRuns": 2
}
```

## When it does not work

| Response                  | Meaning                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 unauthorized`        | No webhook by that name, or a missing, wrong, or un-minted credential. Jazz does not say which, so nobody can list your webhooks by guessing. Check the name, then re-mint the token or secret |
| `409 already received`    | This delivery id or signature already ran. Send a new event                                                                                                                                    |
| `400 ... is not threaded` | A thread key was sent to an `ephemeral` door                                                                                                                                                   |
| `413`                     | Body over 1 MiB                                                                                                                                                                                |
| `429`                     | `maxConcurrentRuns` runs are already in flight. Retry after `Retry-After` seconds                                                                                                              |
| `500 the run failed`      | The run itself failed. The cause is in the daemon's log, never in the answer                                                                                                                   |
| `202 input-required`      | The run needs an approval. See the `allow` list above                                                                                                                                          |

## Next

- [Webhooks](../concepts/webhooks.md): the concept, and when to prefer a peer
- [Surface access](../security/surface-access.md): before you expose the daemon
- [Unattended runs](../security/unattended-runs.md): approvals when nobody is watching
- [`jazz webhook`](../commands.md): the token and secret commands in full
