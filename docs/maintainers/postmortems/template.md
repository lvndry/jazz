---
description: "Template for a Jazz post-mortem: executive summary, impact, timeline, why tests missed it, root cause, the rule it produced and the gate that enforces it."
---

# Post-mortem NNNN: one-line title naming the failure

Status: resolved | mitigated | open

Fix: PR link and commit SHA.

## Executive summary

One paragraph a busy reader absorbs in 30 seconds: what broke, the root cause in plain terms, why it
escaped, and the durable lesson.

## What happened

The mechanism, in the order a reader needs it. Quote the code or error that shows it.

## Impact

Who or what was affected and for how long. State what did not break.

## Timeline

Dated events taken from `git log`, PRs and issues. Link each commit or PR.

## Why tests did not catch it

Name each safety net (unit test, integration test, CI step, review) and why it passed. A missing
test is a finding only when you can say what it would have had to exercise.

## Root cause

The gap that made the bug possible, stated as a property of the code or process.

## The rule

The one sentence a contributor follows next time. Also add it to the doc a contributor reads before
touching the area.

## The gate

The test, lint rule, type, script or CI step that fails when the rule is broken. Link it by path.
A rule with no gate is a request; say so when that is still the case.

## Lessons

2 to 4 bullets that generalize beyond this incident.
