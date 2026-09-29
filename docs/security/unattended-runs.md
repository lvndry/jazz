---
description: "What to decide before a Jazz agent runs with nobody watching: toolset, approval policy, budgets, identity, credentials, and where it actually runs."
---

# Unattended runs

Before scheduling or deploying an unattended agent, restrict its tools, set budgets,
and decide how it should handle approvals.

## 1. Cut the toolset first

Deny tools the job does not need. For example, deny `execute_command` to remove shell access.

Use `deniedTools` rather than omission: `tools` is additive and leaving something out withholds
nothing. A CI reviewer should hold reads, greps, and nothing that writes.

## 2. Pick the lowest policy that does the job

`read-only` for anything that only inspects, keeps todos, or delegates. `low-risk` for jobs that
write memory or set reminders and triggers.
`high-risk` only where the job's whole purpose is to change something, and then only with the
toolset already cut to that one thing.

For specific commands, use `autoApprovedCommands`; see [approvals](./approvals.md).

## 3. Limit time and spending

Set `maxCostUSD`, `maxTokens`, `maxDurationMs`, and `maxIterations`. Cost and token caps are checked
between iterations, so pick numbers with headroom. `maxDurationMs` and `--timeout` are hard walls:
they stop running commands and model calls where they are. See [budgets](../concepts/budgets.md).

## 4. Decide what happens at a gate

Default behaviour is to decline gated calls and report them, which is usually right: the run
finishes and tells you what it could not do.

Use `--park` when the job needs your decision to continue. It saves the run and exits `2`.
Inspect it with `jazz runs show <id>`, then approve with `jazz runs approve <id>` or reject
with `jazz runs reject <id>`. Configure a [notify target](../configure/notifications.md)
to receive its approval request.

## Egress after untrusted input

An inbox digest at `read-only` reads mail somebody else wrote. Without a further rule, the next
call could put anything the agent knows into a URL of that person's choosing.

HTTP requests and page fetches run automatically by default, including unattended runs after
untrusted content. An optional global `network.httpApproval` URL array requires one-call approval
outside its grants, or parking when `--park` is enabled. Risk tiers and session grants cannot
override that list. See [HTTP approvals](../configure/jazz.md#web-request-safety).

For other tools, once a run has read external content (a web page, an API response, a search result, an MCP
result, a peer's answer, or the output of any shell or custom command), other egress tools stop
auto-approving under `read-only`, `low-risk` or an unset policy. They prompt where somebody can
answer, park under `--park`, and are declined otherwise, like any other gated call. The state is
kept for the whole run, shared with its sub-agents, and restored on resume from the labelled
results already in the conversation.

Two exceptions stay automatic: a configured destination, or a URL the run received rather than composed:

- `web_search`, which only reaches the search provider you configured;
- a plain GET (`read_pdf` by URL) of a URL that already appears in your messages or in content the run read. Following a link
  from a page or a search result tells its author nothing new.

Jazz cannot tell what a command read, so any `execute_command` run marks the run: after one, other egress
at `read-only` or `low-risk` needs approval even if the command was `ls`. A job that mixes shell and
network work should do its fetching first or expect to park.

`high-risk` (and `true`) approve egress as before, and an explicit `autoApprovedTools` entry still
counts. If an unattended job needs to post somewhere after reading mail, name that tool in
`autoApprovedTools` for the job, or accept that it parks.

## 5. Give every external conversation a stable identity

A bridge or webhook that reuses one conversation key across senders mixes people's history
together. Derive the key from the platform's own id, and make sure it cannot collide.

## 6. Isolate the host account

Jazz's controls bound what the model chooses to do. The operating system bounds what is reachable
when that fails, and only the second one holds if a prompt injection succeeds.

Run unattended agents as a dedicated OS user, or in a container, with credentials scoped to that
job and nothing else. The Telegram bridge does this per chat, giving each one its own Unix user
and Jazz home, so one person's agent cannot read another's mail credentials.

## 7. Run it in the foreground first, under the real policy

```bash
jazz workflow run my-job --auto-approve
```

This uses the workflow's unattended approval policy, as the scheduler does.

## Related

- [Approvals](./approvals.md): what runs without asking
- [Surface access](./surface-access.md): authenticating the way in
- [Scheduled runs](../surfaces/scheduled.md) · [Headless](../surfaces/headless.md) ·
  [Webhooks](../concepts/webhooks.md)
- [Threat model](./threat-model.md): what none of this stops
