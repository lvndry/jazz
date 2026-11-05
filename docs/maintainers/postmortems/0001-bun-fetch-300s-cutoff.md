---
description: "Post-mortem 0001: Bun aborted any model request still running after 300 seconds, so slow models failed and retried from scratch whatever Jazz's own timeouts allowed."
---

# Post-mortem 0001: Bun's 300-second fetch cutoff killed slow model requests

Status: resolved

Fix: PR #671, commit `db799d8c` (2026-09-26).

## Executive summary

Bun aborts any `fetch` still running after 300 seconds unless the call passes `timeout: false`. Jazz
had set its own, longer limits for model calls (a 15-minute per-call limit and a configurable stream
idle timeout), but every provider was built on the default `fetch`, so Bun's cutoff fired first. A
model that queued or prefilled for more than 5 minutes failed with `TimeoutError` and was retried
from scratch. No test could see it: the tests that exercise providers replace `fetch` with a stub
that answers at once, so Bun's built-in timer was never in the path. Every provider is now built
with `llmFetch`, which passes `timeout: false`, and a test fails if a provider is not.

## What happened

Bun's `fetch` accepts a non-standard `timeout` option and applies a 300-second default, so a request
that was healthy but slow was aborted at the 5-minute mark. The PR names two real cases: NVIDIA NIM, which queued about 200 seconds before its first
token, and a local model prefilling a long prompt. The abort surfaced as `TimeoutError` and the call was retried
from scratch.

The same PR found 2 related defects while in that code:

- `LLM_TIMEOUT_SECONDS` interrupted a non-streaming call without aborting its request, so the
  request kept running after Jazz stopped waiting.
- `groq`, `minimax` and `ai_gateway` were built from the SDK's env-only default instances, so a key
  set with `jazz config set` or held in the keychain was ignored.

## Impact

Any model call that needed more than 300 seconds to finish failed and was retried from scratch,
whatever `llm.streamIdleTimeoutMs` allowed. The PR reports a live streaming `jazz run --stream` on
NIM's `deepseek-ai/deepseek-v4.1-flash` that failed at 300 seconds and retried before the fix, and
completed in 473 seconds with one tool call after it.

Calls that finished inside 300 seconds were unaffected.

## Timeline

- 2026-05-03: `e7a1565b` raised the LLM request timeout floor to 10 minutes.
- 2026-05-05: `5aabc714` (#237) set the per-call limit to 15 minutes. Both changes raised Jazz's own
  limit; neither could take effect past Bun's 300 seconds.
- 2026-09-26: #671 opened and merged the same day, adding `llmFetch` and routing every provider
  through it.

## Why tests did not catch it

- Provider tests intercept requests by assigning `globalThis.fetch` a stub that returns a
  `Response` immediately (for example the NIM endpoint test in `ai-sdk-service.test.ts` before the
  fix). Bun's timer lives in the real `fetch`, which those tests replace.
- The 300-second limit needs a request that stays open for 5 minutes, and no test in that file
  asserted anything about the options a provider passes to `fetch`. Before #671,
  `ai-sdk-service.test.ts` did not mention a timeout at all.

## Root cause

Jazz delegated the transport to a runtime default it did not know existed. Its timeout design had 2
layers (stream idle timeout and per-call limit) and a third, invisible one underneath with a lower
value, so the effective limit was `min(300s, Jazz's limit)` and the configured values were
decorative above 300 seconds.

## The rule

Every LLM provider is constructed with `llmFetch` from
[`llm-fetch.ts`](../../../packages/adapters/src/llm/llm-fetch.ts), never with the SDK's default
instance or the global `fetch`. A request is bounded by Jazz's own limits, and a wrapper around a
provider's `fetch` (the ChatGPT OAuth fetch, the Ollama keep-alive fetch) delegates to `llmFetch`.

The rule is written in the `llmFetch` docstring and in
[Providers and models](../add-a-provider.md#retries-and-timeouts).

## The gate

The test `sends every provider's model request with its configured key and without Bun's fetch timeout`
in [`ai-sdk-service.test.ts`](../../../packages/adapters/src/llm/ai-sdk-service.test.ts) iterates
`AVAILABLE_PROVIDERS`, sends one request through each, and fails for any provider whose request did
not carry `timeout: false`. A newly added provider is covered without editing the test. The 2
exemptions, `chatgpt` and `claude_code`, are named in the test with the reason: ChatGPT resolves an
OAuth credential before any request, and Claude Code runs through the user's own `claude` binary
rather than an HTTP request. The second was added by #937, which is the gate doing its job: a new
provider had to state why it is exempt.

[`llm-fetch.test.ts`](../../../packages/adapters/src/llm/llm-fetch.test.ts) pins that `llmFetch`
sets `timeout: false` and preserves the caller's method, body and signal.

## Lessons

- A timeout you configure is only a bound if nothing below it is shorter. List the layers under a
  limit before trusting it.
- A test that replaces the transport cannot test the transport's defaults. Assert on the options the
  call passes down, which is what the gate does.
- Enumerate every provider in a gate rather than checking a sample, so the next provider is covered
  without anyone remembering the rule.
