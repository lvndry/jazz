---
description: "What Jazz writes to disk, which paths and JSON shapes are stable contracts you may build on, and which are internal and free to change."
---

# Runtime data and contracts

Jazz keeps everything under one directory, `~/.jazz` by default, moved with `JAZZ_HOME` or
`--data-dir`. This page says what is in it and, more usefully, which parts you may build on.

## What is on disk

| Path                                                              | Holds                                                              | Stable?                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------- |
| `config.json`                                                     | Global configuration. Secrets are **not** here                     | yes                     |
| `agents/`                                                         | One JSON file per agent                                            | yes                     |
| `personas/`                                                       | Your custom personas                                               | yes                     |
| `skills/`                                                         | Your installed and hand-written skills                             | yes                     |
| `workflows/`                                                      | Your workflow files                                                | yes                     |
| `memory/`                                                         | Durable memory, by scope                                           | yes                     |
| `workspace/`                                                      | Per-agent scratchpad                                               | yes                     |
| `history/`                                                        | Conversation logs, one append-only file per conversation           | shape may change        |
| `history/archive/`                                                | Conversations past the retention limit, gzip-compressed            | shape may change        |
| `runs/`                                                           | One record per run, pruned once terminal                           | shape may change        |
| `job-batches/`                                                    | Background job batches in flight; delivered ones under `.archive/` | internal                |
| `work/`                                                           | Per-conversation work state, journal, and offloaded tool results   | internal                |
| `generated/`                                                      | Media a model produced, referenced by artifacts                    | path is in the artifact |
| `logs/`                                                           | `jazz.log`, per-conversation logs, per-workflow stdout and stderr  | yes                     |
| `logs/one-shot/`                                                  | Output of each fired reminder or wake-trigger job (macOS)          | internal                |
| `telemetry/`                                                      | Local NDJSON events, pruned after `telemetry.retentionDays`        | yes                     |
| `runtime/`, `cache/`, `misfires/`, `memory-recall/`, `schedules/` | Bookkeeping                                                        | internal                |

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

## Sizes and retention

Everything Jazz writes on its own is bounded. What you write (memory, workflows, the
workspace) is yours to manage.

| Data                          | Bound                                                                                            | Setting                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Conversation logs             | Grow with what was said, about 2 KB per turn of a typical chat                                   |                                    |
| Conversations per agent       | 100 most recently used stay in `history/`; older ones move to `history/archive/`                 | `history.maxConversationsPerAgent` |
| Files in `logs/`              | Rotated at 10 MB (two older copies, `name.1` and `name.2`); deleted 14 days after the last write | `logging.retentionDays`            |
| The whole `logs/` directory   | 200 MB; past that the least recently written files are deleted first                             | `logging.maxTotalSizeMB`           |
| `logs/one-shot/`              | Deleted a day after the job fired                                                                |                                    |
| Job batches                   | Moved to `job-batches/.archive/` once their results reached the agent; deleted after 7 days      |                                    |
| `memory-recall/`, `misfires/` | 4 MB each, plus one rotated copy                                                                 |                                    |
| `telemetry/`                  | Deleted after 90 days                                                                            | `telemetry.retentionDays`          |
| `runs/`                       | Records pruned once terminal                                                                     |                                    |

A conversation is archived, never deleted, and only when it is past the limit: a conversation
that a goal, a loop or a run still names stays in `history/`, so an agent that works in the
background always finds its conversation where it left it. Each archived conversation is noted
in `logs/jazz.log`. To read one, decompress it (`gunzip -c
~/.jazz/history/archive/conversations/<agent>/<conversation>.jsonl.gz`); to bring it back, put
the decompressed file in `history/conversations/<agent>/`.

A conversation log records each turn once. The UI scrollback saved alongside it is appended the
same way, as the entries added since the last save, with a full copy only after `/clear`. Logs
written by an older Jazz, which stored the whole scrollback on every save, are compacted the
next time the conversation is saved.

The history layout that predates per-agent directories (`history/<agent>.json` indexes and
`history/sessions/`) is no longer read. The first save after upgrading moves those files to
`history/archive/legacy/`; delete that folder once you are sure you do not need it.

Log cleanup runs at most once an hour, as part of normal logging, so it needs no daemon or
schedule. The settings live in `config.json`:

```json
{
  "logging": { "retentionDays": 30, "maxTotalSizeMB": 500 },
  "history": { "maxConversationsPerAgent": 300 }
}
```

## Related

- [Conversations and memory](../concepts/conversations-and-memory.md): what each kind of state is for
- [Configuration](../configure/jazz.md): `JAZZ_HOME`, project overrides, storage settings
- [Lexicon](../concepts/lexicon.md): the word for each of these
