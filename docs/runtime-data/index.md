---
description: "What Jazz writes to disk, which paths and JSON shapes are stable contracts you may build on, and which are internal and free to change."
---

# Runtime data and contracts

Jazz keeps everything under one directory, `~/.jazz` by default, moved with `JAZZ_HOME` or
`--data-dir`. This page says what is in it and, more usefully, which parts you may build on.

## What is on disk

| Path                                                              | Holds                                                            | Stable?                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| `config.json`                                                     | Global configuration. Secrets are **not** here                   | yes                     |
| `agents/`                                                         | One JSON file per agent                                          | yes                     |
| `personas/`                                                       | Your custom personas                                             | yes                     |
| `skills/`                                                         | Your installed and hand-written skills                           | yes                     |
| `workflows/`                                                      | Your workflow files                                              | yes                     |
| `memory/`                                                         | Durable memory, by scope                                         | yes                     |
| `workspace/`                                                      | Per-agent scratchpad                                             | yes                     |
| `history/`                                                        | Conversation logs, one append-only file per conversation         | shape may change        |
| `runs/`                                                           | One record per run, pruned once terminal                         | shape may change        |
| `work/`                                                           | Per-conversation work state, journal, and offloaded tool results | internal                |
| `generated/`                                                      | Media a model produced, referenced by artifacts                  | path is in the artifact |
| `logs/`                                                           | Per-workflow stdout and stderr from scheduled runs               | yes                     |
| `telemetry/`                                                      | Local NDJSON events, pruned after `telemetry.retentionDays`      | yes                     |
| `runtime/`, `cache/`, `misfires/`, `memory-recall/`, `schedules/` | Bookkeeping                                                      | internal                |

"Stable" means the location and the format are a contract: Jazz will not move or reshape them
without saying so. "Internal" means exactly the opposite, and a script that parses them will
break.

## The contracts worth integrating against

Prefer these to reading files:

- **[The JSON envelope](../surfaces/headless.md)**: `jazz run --json` prints exactly one object,
  on success and on failure, with `ok`, `answer`, `costUSD`, `costKnown`, `tokenUsage`,
  `toolCalls`, and `artifacts`. This is the integration surface.
- **[Event streams](../surfaces/headless.md#live-progress-with---events)**: NDJSON on stderr while
  stdout stays clean, so a wrapper can show progress without parsing output.
- **[The daemon's HTTP API](../concepts/daemon.md)**: start a run, poll it, answer what it parked
  on, from another process or machine.
- **Exit codes**: `0` success, `1` failure, `2` parked and waiting for a person.

## Where things are written, and when

A run's transcript is saved when the run finishes, not incrementally, so reading `history/`
mid-run tells you nothing about the turn in flight. Use the daemon or `--events` for that.
[Run lifecycle](../maintainers/run-lifecycle.md) has the exact ordering.

Telemetry is the exception: it is written as events happen, whether or not you export anywhere.
See [observability](../configure/observability.md).

## Related

- [Conversations and memory](../concepts/conversations-and-memory.md): what each kind of state is for
- [Configuration](../configure/jazz.md): `JAZZ_HOME`, project overrides, storage settings
- [Lexicon](../concepts/lexicon.md): the word for each of these
