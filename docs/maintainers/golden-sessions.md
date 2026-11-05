---
description: "Replay recorded model streams through the real agent runner in CI, with no keys, and how to add a scenario and what to assert."
---

# Golden sessions

A golden session replays a recorded model conversation through the real agent runner, tool
registry, approval gate, checkpointing and conversation persistence. Only the model is faked.
It exists because a green unit suite has missed bugs that a run through the loop found.

Source: [`packages/adapters/src/llm/golden/`](../../packages/adapters/src/llm/golden/). Run with
`bun test packages/adapters/src/llm/golden`. No keys, network or daemon are involved.

## How it works

- **Fixture**: one entry per model call, holding the request summary (message roles, tool names
  offered, tool results fed back) and the AI SDK `fullStream` parts the model produced.
- **Replay** (`replay.ts`): serves entries in order. The parts run through the real
  `StreamProcessor`, so stream events, usage and tool-call parsing are shipping code. A call
  beyond the fixture, a different set of tools offered, or a different role sequence fails with a
  diff of expected against actual. A run that makes fewer calls than recorded fails
  `assertExhausted()`.
- **Harness** (`harness.ts`): `createGoldenSession` runs `AgentRunner.run` with scripted tools in
  the real registry, `onCheckpoint` persisting to a temp directory, and an in-memory run store
  for parking. It exposes `events`, `checkpoints`, `loadSaved()` and `resumeParked()`.
- **Scrubbing** (`scrub.ts`): secrets, credential-shaped tokens, home directory, username,
  hostname, temp directory, timestamps and random ids become stable placeholders.

## Recording a session

Authors record; CI only replays.

```sh
JAZZ_GOLDEN_RECORD=packages/adapters/src/llm/golden/fixtures/my-scenario.json \
  jazz run "the prompt"
```

The AI SDK service scrubs each streamed call as it arrives and rewrites the file after every
call. Secret-named environment values and the configured provider key are scrubbed by value.
Read the file before committing it: scrubbing is a safety net, and a recording made against a
real conversation can still hold personal text. Replace such text with neutral wording, then keep
the part shapes as recorded. Never commit a recording of a real conversation.

## Adding a scenario

1. Record or hand-write `fixtures/<name>.json`. List every tool the run offers, including the
   built-in skill tools, in the request summary of each call.
2. Add a test in `scenarios.test.ts` that opens a session with the fixture and the scripted tools
   the scenario needs.
3. Run it. A drift failure names the missing or extra tool or role; fix the fixture only when the
   change is intended.

## What to assert

Assert behavior on the transcript and events using `transcript.ts`:

- the ordered roles of the transcript
- tool call names and argument keys, not argument values
- each tool result answers a call, and no call is left unanswered
- parked, completed and interrupted states, and which checkpoint phases were taken
- a final assistant answer exists, and usage was reported

Do not snapshot text. Do not regenerate a fixture to make a failing test pass: a refreshed
expectation without a semantic assertion blesses the regression. For wording that a producer
owns (such as the interrupted-result text), derive it from the producing function instead of
copying the string.

## Scenarios

| Scenario             | Proves                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| plain-answer         | One call, usage, a persisted transcript, no tool traffic                       |
| tool-call-result     | A tool runs once and its result reaches the next request                       |
| approval-park-resume | A mutating call parks unattended, runs once on approve, then answers           |
| empty-finish-retry   | An empty model finish is retried and then answered                             |
| interrupted-batch    | A kill mid-batch leaves a saved checkpoint with the call closed as interrupted |
