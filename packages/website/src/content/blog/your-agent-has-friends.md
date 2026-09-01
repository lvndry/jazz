---
title: "Your agent has friends now, and here's what that unlocks"
description: "Jazz 0.15.13 lets your agent talk to other agents, other people's and other frameworks'. No shared passwords, no merged data. A tour of what becomes possible when agents can ask each other one bounded question at a time."
date: 2026-08-31
---

Jazz runs AI agents on your own machine. They can read your files, run your git,
check your email, act on your behalf. The newest release opens something that was
missing: your agent can now talk to other agents, ones running on other
people's machines, built by other people, sometimes on other frameworks.

Not by handing over your password. By asking a question, and getting exactly the
answer you decided in advance they're allowed to have.

Here's what that actually unlocks.

## "Does your dataset include anyone under 18?" without sharing the dataset

Two labs are collaborating. Yours trained a model on a sensitive corpus. A partner
lab's agent needs to know, for a compliance form, whether your data includes
subjects under 18. Theirs asks; yours answers. To do it, your agent only needed to
check a provenance file it was allowed to read, not hand over the whole corpus.

Neither lab merged datasets. Nobody got read access to the other's drive. The
partner's agent got an *answer*, not *access*. That's the whole shift: instead of
wiring two systems together so they can read each other, you let two agents exchange
one bounded reply.

## A public face that isn't your real assistant

A freelancer can let their agent answer "what do you charge?" for anyone who
asks, at a `public` tier that only admits what's safe to tell a stranger. That
same agent, behind the same endpoint, never brings the assistant that reads their
actual inbox and calendar into that conversation.

One agent, many faces. The world sees a public skill; vetted peers see more.
Each caller gets only their own relationship's ceiling.

## A non-Jazz agent can reach yours

[A2A](https://linuxfoundation.org) (Agent2Agent) is the open standard for two
agents to find and talk to each other regardless of who built them. Jazz
puts A2A in front of its existing agent-to-agent system. So a teammate's LangGraph
agent, a Go service, or a cron job that learned JSON-RPC can reach your Jazz agent
and get exactly the bounded answer you configured.

You don't have to be a Jazz user to talk to a Jazz agent. They speak the
standard; your trust model does the rest.

## A stranger's software, but bounded

The thing that makes all of the above safe-ish rather than terrifying is that the
limit is set in advance and enforced by construction. When a peer asks your agent
a question, that question runs in its own isolated conversation with a toolset
built from scratch, it is never handed a tool outside its tier. Ask it to read a
file it wasn't allowed to see and it doesn't refuse; it has no such tool. There's
nothing for a persuasive question to reach.

Every exchange, both directions, lands in a ledger you can read back, including
the ones a tier refused. "I can't answer that" is still worth recording.

## Try it

The [five-minute tutorial](/blog/wire-up-your-first-peer) walks you through
wiring up two agents on one machine and watching a tier refuse to over-share. If
you want the longer read on why this shape matters, the
[essay](/blog/the-missing-door) is it.
