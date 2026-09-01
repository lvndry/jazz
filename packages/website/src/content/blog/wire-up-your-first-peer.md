---
title: "Wire up your first peer in five minutes"
description: "Two agents, one machine, one bounded question. A copy-paste walkthrough of Jazz's agent-to-agent links: serve, invite with a link, accept, ask, and watch a tier refuse to over-share."
date: 2026-08-31
---

In five minutes you'll have two agents on your machine asking each other
questions, with a tier that caps what the asking side is allowed to learn,
enforced so strictly there's no tool for it to reach past.

You only need Jazz installed. We'll run two agents on one machine by giving each
its own data directory, so they never see each other's state.

## 1. Create two agents

```bash
jazz --data-dir /tmp/jazz-alice agent create   # name it "alice"
jazz --data-dir /tmp/jazz-bob   agent create   # name it "bob"
```

`--data-dir` points a single `jazz` binary at its own agents, config, and
credentials. That's how one machine runs two fully separate setups.

## 2. Bob serves

```bash
jazz --data-dir /tmp/jazz-bob daemon --serve-peers bob --port 4748
```

Leave that running in its own terminal. Loopback by default, so nothing outside
this machine can reach it.

## 3. Bob invites Alice

```bash
jazz --data-dir /tmp/jazz-bob peers invite create alice --port 4748 --disclosure internal --expires 1h
```

`--disclosure internal` is the ceiling: the most Alice's agent may ever learn
from Bob's, set by Bob, before Alice does anything. The command prints a link.
Send it to Alice out of band (a chat message, not a commit).

You never typed a token. The link carries a one-time secret; the real credential
is minted by Bob's daemon at the moment Alice accepts, and handed to her then. A
leaked link is spent, not a standing key.

## 4. Alice accepts

```bash
jazz --data-dir /tmp/jazz-alice peers invite accept "<the link bob sent>"
```

She sees who invited her, at what endpoint, and what tier. Confirms once.

## 5. Give Alice the asking tool

```bash
jazz --data-dir /tmp/jazz-alice agent edit alice   # tick ask_peer
```

`ask_peer` only appears once a peer exists. A tool the model can see is a tool
it will try.

## 6. Ask

```bash
jazz --data-dir /tmp/jazz-alice run --agent alice "ask bob's agent what the status of deploy #4821 is"
```

`internal` admits read-only tools like `git` and `ls`, so you get a real answer
back, attributed and quoted as something Bob's agent said, not as a fact Alice's
agent should obey.

## 7. Watch a tier refuse

```bash
jazz --data-dir /tmp/jazz-alice run --agent alice "ask bob's agent to read his ~/.bashrc and summarize it"
```

Bob's agent says it cannot. This is not it deciding to be unhelpful, and it is
not that Bob's agent can't read files in general. It is the `internal` tier Bob
granted Alice: that tier does not admit `read_file`, so the tool was never put
into this run's toolset. There is no prompt to argue with, nothing to approve,
and nothing for a persuasive question to reach.

## 8. Read the ledger, both sides

```bash
jazz --data-dir /tmp/jazz-bob   peers log   # what Bob was asked, and what he said
jazz --data-dir /tmp/jazz-alice peers log   # what Alice asked, and what came back
```

The refused request shows up too, with the actual reply. That's the point of
logging the answer and not just the outcome.

## Next

[peer setup guide](/docs/start/peers-setup).

The [showcase](/blog/your-agent-has-friends) shows what else this unlocks; the
[essay](/blog/the-missing-door) is the why.
