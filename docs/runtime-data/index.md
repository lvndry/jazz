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

## Permissions

Everything Jazz writes under the home is private to your account: files are `0600` and
directories `0700`, so another account on a shared machine cannot read your conversations,
memory, logs, or state. Each command makes the home itself owner-only, and the first command
run against a home also walks it once and clears the group and other permission bits on
everything your account already wrote there (your own bits, execute included, are kept;
symbolic links and other accounts' files are left alone). A `.permissions-repaired` file marks
that the walk has run.

A home whose directory has the setgid bit is treated as shared with its group on purpose.
The chat bridges set up each conversation's home that way so the operator can read it, and
there Jazz keeps group read and removes only the bits for everyone else.

## Damaged and newer files

State files that are replaced as a whole (`config.json`, agents, memory, run history,
reminders, wake triggers, job batches, `state.json`) are written to a temporary file, flushed
to disk, and renamed into place, so a crash or power cut leaves either the old file or the new
one.

Reminders, wake triggers, job batches, run history, and `state.json` carry a `schemaVersion`.
When one of them cannot be read (torn JSON, a wrong shape), Jazz moves it aside to
`<name>.corrupt-<timestamp>`, prints a warning with both paths, and starts a fresh file, so the
damaged bytes are kept for you to recover rather than overwritten. A file with a
`schemaVersion` newer than your Jazz understands, or a conversation log with a newer header
version, is refused and left untouched: update Jazz to use it.

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
