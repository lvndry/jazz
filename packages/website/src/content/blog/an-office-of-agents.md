---
title: "Building an office of agents, not one assistant"
description: "A deep dive into four real productivity and small-business workflows that only work once you stop building one big assistant — using Jazz's personas, skills, the always-on daemon, and peers together."
date: 2026-08-30
---

Most "AI for your business" pitches converge on the same shape: one chatbot, trained or
prompted on everything, that everyone in the company talks to. It's a reasonable place to
start and a strange place to stop, because it recreates the exact problem a real office
solved a century ago by not having one person do every job. A receptionist isn't the
bookkeeper. The person who answers the phone shouldn't also be the one with access to
payroll. Specialization isn't overhead — it's how you keep a large surface area of
responsibility from becoming one large surface area of risk.

Jazz gives you four primitives that compose into exactly that shape, and none of them are
new individually: a **persona** shapes how an agent talks and what it defaults to caring
about; a **skill** is a packaged playbook for doing one thing well; the **daemon** keeps an
agent answering — over HTTP, on a schedule, from Telegram — after you've closed the laptop;
and **peers** let two of these agents ask each other a bounded question without merging
whatever they each know. Individually, each is a small feature. Composed, they stop looking
like a chatbot and start looking like a small office. Here are four workflows that only make
sense once you see it that way.

## 1. A front desk that isn't your real assistant

A solo consultant or small studio wants prospective clients to be able to ask "are you
available in October" and "what's your day rate" without exposing the assistant that actually
reads their inbox and calendar. The fix isn't a chatbot widget with a system prompt telling it
what not to say — a model under enough pressure will eventually say it anyway. The fix is two
separate agents that never share a toolset:

```bash
jazz agent create   # "front-desk" — persona: brief, on-brand, no filesystem/mail tools at all
jazz agent create   # "ops" — persona: terse and direct, full calendar/mail/file access
```

`front-desk` gets served to the world at `public` tier — the shape of "safe to tell anyone" —
and nothing else, because that's the ceiling the tier enforces regardless of what the agent
is asked:

```bash
jazz daemon --serve-peers front-desk
jazz peers invite create prospective-client --may public --expires 24h
```

`ops` is never served to a peer at all. It's not a matter of trusting `front-desk` to behave —
it structurally cannot reach a calendar it was never given a tool to read. The client's agent
gets a real answer to a real question, and the assistant that manages the actual business
never enters the conversation.

## 2. A daily status digest nobody had to write

Small teams default to a shared channel everyone posts standup notes into, which works until
it doesn't — half the value is buried in a scroll nobody rereads. The alternative: everyone
runs their own agent, in their own voice —

```bash
JAZZ_HOME=$MAYA jazz agent create    # persona: dry, links-only, hates meetings
JAZZ_HOME=$SAM  jazz agent create    # persona: verbose, likes context
```

— and a lead's agent asks each one the same bounded question on a schedule, as a
[workflow](/docs/concepts/workflows):

```bash
jazz workflow run status-check   # "ask maya's agent and sam's agent what shipped yesterday"
jazz workflow schedule status-check --at "09:00" --days weekdays
```

Under the hood that's `ask_peer` twice, each answer coming back quoted and attributed, and a
skill that formats the two replies into one digest — sent to Telegram, so the lead reads it on
their phone before the first meeting, without anyone having typed a status update into a
shared doc. Because the daemon is what's actually alive at 9am, not a human remembering to
run something, this is also the first place "safe to leave running" stops being an abstract
claim: the workflow only ever *asks*, at a tier the teammate chose in advance, and the ledger
on both sides is the record of exactly what was said.

## 3. On-call, without giving the router your laptop

A support or ops rotation needs to know who can take the next incident. The naive version
gives a router bot broad access to everyone's calendar; the peer version asks a narrower
question and gets a narrower answer. Each on-call engineer serves their own agent at
`about-me` — enough to say "free" or "in a meeting until 3" — and a triage agent asks whoever's
next in the rotation:

```bash
jazz run --agent triage "ask jordan's agent whether they can take a P1 right now"
```

If Jordan's agent says no, the triage agent moves to the next name. Nobody's full calendar was
ever on the table, and `jazz peers log` on Jordan's side shows exactly what was asked and
said — which matters more than it sounds like, because "I don't remember agreeing to that"
stops being a possible sentence when the exchange is logged verbatim on both ends.

## 4. A household that doesn't merge two phones into one context

Not every use of this is a business. Two people sharing groceries, reminders, and a
household budget don't actually want one shared assistant reading both inboxes — they want
their own agents to be able to check one thing with each other:

```bash
jazz peers invite create partner --may about-me --expires 24h
jazz run --agent mine "ask my partner's agent if we still need milk"
```

Each side keeps their own `add_reminder` skill, their own persona, their own private
context — the peer link is the one narrow door between two otherwise separate lives, and it's
a door either side can close by setting the tier back to `none`.

## The composition is the point

None of these four are hard to build individually — a persona is a system prompt, a skill is
a folder, the daemon is a long-running process, a peer is a tiered HTTP door. What's actually
new is that they compose without any of them needing to know about the others. The front-desk
agent doesn't know it's protecting `ops`; it just has fewer tools. The status-digest workflow
doesn't know it's replacing a standup channel; it just asks two questions on a schedule. The
office metaphor isn't a marketing frame — it's the literal architecture: several small,
scoped things, each auditable on its own, instead of one large thing you have to trust
completely.

## Try it

```bash
curl -fsSL https://github.com/lvndry/jazz/releases/latest/download/install.sh | bash
jazz agent create
```

Start with one agent and a [skill](/docs/concepts/skills) or two; add a second agent and a
[peer invite](/docs/concepts/peer-invites) once there's an actual second person or a second
concern worth separating. The [workflow cookbook](/docs/cookbook) has forkable schedules for
digests and check-ins, and [Setting up peers](/docs/guide/peers-setup) walks the invite flow
end to end on one machine before you ever need a second one.
