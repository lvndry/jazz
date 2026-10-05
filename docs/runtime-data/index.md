---
description: "What Jazz writes to disk, which paths and JSON shapes are stable contracts you may build on, and which are internal and free to change."
---

# Runtime data

Use this reference to find configuration, conversations, generated files, and logs,
or to adjust how much history Jazz retains. Jazz stores its data under `~/.jazz` by default;
`JAZZ_HOME` or `--data-dir` selects another directory.

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
| `chat-attachments/`                                               | Which conversation each open chat holds, so its wake-ups run there | internal                |
| `work/`                                                           | Per-conversation work state, journal, and offloaded tool results   | internal                |
| `generated/`                                                      | Media a model produced, referenced by artifacts                    | path is in the artifact |
| `logs/`                                                           | `jazz.log`, per-conversation logs, per-workflow stdout and stderr  | yes                     |
| `logs/one-shot/`                                                  | Output of each fired reminder or wake-trigger job (macOS)          | internal                |
| `telemetry/`                                                      | Local NDJSON events, pruned after `telemetry.retentionDays`        | yes                     |
| `runtime/`, `cache/`, `misfires/`, `memory-recall/`, `schedules/` | Bookkeeping                                                        | internal                |

Stable paths and formats are supported for integration. Internal formats can change;
use the CLI or HTTP API instead of parsing them.

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
there Jazz keeps group read and removes only the bits for everyone else. The bridge’s outer
shared home has setgid and traversal-only access for other accounts (typically `2751`), so
conversation accounts can reach their own homes under `chats/`. CLI startup leaves that
operator-managed hierarchy alone; the bridge entrypoint repairs its permissions, preserving
shared personas and sandbox traversal. Conversation homes (`2750`) still receive CLI repair.

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
- **[Event streams](../surfaces/headless.md#live-progress-with---watch)**: NDJSON on stderr while
  stdout stays clean, so a wrapper can show progress without parsing output.
- **[The daemon's HTTP API](../concepts/daemon.md)**: start a run, poll it, answer what it parked
  on, from another process or machine.
- **Exit codes**: `0` success, `1` failure, `2` parked and waiting for a person.

## Where things are written, and when

A `jazz run` transcript is saved when the run finishes, not incrementally, so reading `history/`
mid-run tells you nothing about the turn in flight. Use the daemon or `--watch` for that.

A chat conversation is saved as the turn goes: your message before the first model call, then
after every step (a model response and the tool results it asked for), and again when the turn
ends or the process is stopped with Ctrl+C or SIGTERM. A turn killed outright keeps everything up
to its last finished step. `/resume` dates each conversation by its newest message.

Telemetry is the exception: it is written as events happen, whether or not you export anywhere.
See [observability](../configure/observability.md).

## Sizes and retention

Jazz rotates logs, archives older conversations, and expires telemetry. Memory, workflows,
and workspace content remain yours to manage.

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

Job batches remain active until their fan-in turn finishes or parks and `deliveredAt` is recorded. Failed deliveries remain available for retry; the periodic archive sweep never removes an undelivered batch.

A conversation is archived, never deleted, and only when it is past the limit: a conversation
that a goal, a loop or a run still names stays in `history/`, so an agent that works in the
background always finds its conversation where it left it. Each archived conversation is noted
in `logs/jazz.log`. To read one, decompress it (`gunzip -c
~/.jazz/history/archive/conversations/<agent>/<conversation>.jsonl.gz`); to bring it back, put
the decompressed file in `history/conversations/<agent>/`.

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
