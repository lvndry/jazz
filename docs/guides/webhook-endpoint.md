---
description: "Build an authenticated HTTP door that wakes one Jazz agent with a fixed prompt, test it with curl, then point a real GitHub webhook at it."
---

# Wake an agent from another system with a webhook

Everything else in Jazz starts when you do: you type, a schedule fires, CI runs a job. A
webhook is the other direction. Something outside knocks, and an agent wakes up. A GitHub
issue is opened, a deploy finishes, a form is submitted, and the agent reads it and answers.

This guide builds one end to end: an issue-triage door you can fire with `curl` in five
minutes, then point GitHub at. By the end you will have used the four things that make a
webhook different from a `jazz run` in a shell script: a fixed prompt the caller cannot replace,
a per-door bearer token, a tool ceiling for a caller who is not you, and an optional threaded
conversation.

## What a webhook is, precisely

One URL name bound to one agent and one prompt template, served by `jazz daemon`:

```text
POST /webhooks/<name>  →  agent <agentId> runs <promptTemplate>, with the body quoted in
```

The caller chooses **nothing** except the payload. Not the agent, not the prompt, not the
tools. The payload arrives inside the prompt clearly marked as data, never spliced in as an
instruction, the same treatment `web_fetch` output and a peer's reply get.

That is the whole security posture, and it is why a webhook is the right shape for structured
events from another application. When the other side needs to ask open-ended questions, you
want a [peer](../concepts/agent-to-agent.md) instead.

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

Four of those fields carry weight:

| Field            | What it decides                                                                         |
| ---------------- | --------------------------------------------------------------------------------------- |
| `name`           | The URL (`/webhooks/issue-triage`) and which token unlocks it                            |
| `agentId`        | Which agent wakes, by id or by name                                                     |
| `promptTemplate` | The entire instruction. `{{payload}}` is where the body lands, quoted as data            |
| `disclosure`     | The ceiling on what the run may reveal. Defaults to `internal` when you leave it out     |

Leave `{{payload}}` out and the payload is appended at the end instead, with the same quoting
and less control over where it sits.

Say what you want back, in the template, as specifically as you can bear. The caller is a
program: "reply with exactly three lines" is the difference between a response it can parse
and a paragraph it cannot.

## 3. Mint the token

Each door carries its own credential. Jazz generates it, stores it in the OS keyring, and
prints it exactly once:

```bash
jazz webhook token issue-triage
```

Copy the value now. If you lose it, run the command again to mint a new one, which overwrites
the old. On a host with no keyring (a container), set
`JAZZ_WEBHOOK_TOKEN_ISSUE_TRIAGE` in the daemon's environment instead.

The token never goes in `config.json`. It authenticates *this webhook*, not you. See
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

Then, in the repository's **Settings → Webhooks → Add webhook**:

- **Payload URL:** `https://<your-host>/webhooks/issue-triage`
- **Content type:** `application/json`
- **Secret:** leave empty. Jazz authenticates with the bearer token, not GitHub's HMAC
- **Events:** *Let me select individual events* → **Issues**

GitHub does not send an `Authorization` header, so terminate at a proxy that adds it:

```nginx
location /webhooks/ {
  proxy_set_header Authorization "Bearer <token>";
  proxy_pass http://127.0.0.1:4747;
}
```

That proxy is now the thing holding the credential. Give it the same care as the keyring.

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
Sending a thread key to an `ephemeral` door is refused with a `400` rather than ignored. A
caller that believes its turns are accumulating somewhere deserves to be told they are not.

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
omit the header to get all three. A misspelled kind is a `400`, not a silence.

The URL must be loopback. Anywhere else, and this feature would be a way to make your daemon
knock on doors chosen by whoever holds the token.

## What the caller can and cannot do

A webhook token lives in somebody else's settings screen: a GitHub repo's webhook config, an
IFTTT applet, a proxy. You do not administer that place and cannot audit it. So Jazz treats
the holder as an external counterparty, never as you, and bounds the run on two independent
axes:

- **`disclosure`** is a ceiling on what an answer may *reveal*. `internal` (the default) is
  read-only tools that describe the shape of the machine (what exists, what is installed, what
  the web says) but not the contents of your files or your memory. `public` is less,
  `private` is the most an external caller can ever hold, and `none` reaches nothing.
- **`allow`** is the separate question of *damage*. Disclosure says nothing about acting, so a
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

An unnamed tool is not offered to the model at all. It is absent from the run, not queued for
an approval nobody is there to give. That is what makes an injected payload a dead end: there
is nothing outside the list for it to talk its way into.

If the run does reach something needing approval, the fire returns `202` with a run id rather
than hanging:

```json
{ "ok": false, "state": "input-required", "runId": "run_01H...", "pending": "..." }
```

Approve it yourself later with `jazz runs approve <runId>`, or leave those tools out.

## When it does not work

| Response                             | Meaning                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `401 unauthorized`                   | Missing, wrong, or un-minted token. Re-run `jazz webhook token <name>`           |
| `404 not found`                      | No webhook by that name in `config.json`. Check spelling, not the daemon        |
| `400 ... is not threaded`            | A thread key was sent to an `ephemeral` door                                     |
| `413`                                | Body over 1 MiB                                                                  |
| `202 input-required`                 | The run needs an approval. See the `allow` list above                            |

## Next

- [Webhooks](../concepts/webhooks.md): the concept, and when to prefer a peer
- [Surface access](../security/surface-access.md): before you expose the daemon
- [Unattended runs](../security/unattended-runs.md): approvals when nobody is watching
- [`jazz webhook`](../commands.md): the token commands in full
