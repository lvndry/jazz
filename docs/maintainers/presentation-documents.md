---
description: "Trace Jazz's semantic conversation document, atomic presentation snapshots, stream identity, renderer projections, and versioned history storage."
---

# Conversation presentation

A conversation has one source document. Terminal layouts project its entries;
history saves the same entries. Resuming does not replay formatted output to
recover tool receipts, reasoning, or response identity.

Source: [presentation types](../../packages/core/src/types/presentation-content.ts),
[document operations](../../packages/cli/src/ui/document.ts),
[store](../../packages/cli/src/ui/store.ts),
[history boundary](../../packages/adapters/src/history/conversation-log.ts), and
[hydration](../../packages/cli/src/ui/hydrate-transcript.ts).

## Ownership

| State                                                                            | Owner                       | Persistence                              |
| -------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| User text, response Markdown, reasoning, receipt facts, reports, turn statistics | Presentation document       | Semantic entries in the conversation log |
| Provider stream lifecycle and revealed character count                           | Live presentation state     | Omitted; restored responses are settled  |
| Approval continuations, prompt resolvers, secret drafts                          | Interactive session         | Omitted                                  |
| Scroll intent, content anchor, focus, selection                                  | Mounted view                | Omitted                                  |
| Wrapped rows, syntax styles, geometry, terminal pixels                           | Layout and terminal runtime | Omitted                                  |

`PresentationContent` is a discriminated union in `core/`. It carries facts, not
React nodes or terminal-specific metadata. CLI producers translate events at the
presentation boundary. Tool outcomes remain structured data; painters choose
whether several consecutive receipts fit together on one row.

`UIStore.getPresentationSnapshot()` publishes the document and related live
state together. The fullscreen bridge consumes that snapshot. A document
replacement is one transaction; it invalidates pending stream work instead of
clearing the screen and reprinting entries individually.

The snapshot's `documentGeneration` identifies the mounted-view lifetime, separately
from the persistent document ID. Replacing or clearing source advances this generation
even when document and entry IDs are reused. The fullscreen bridge includes it in
viewport identity, so a replacement starts at the live edge with a fresh unseen
baseline. Ordinary stream appends and settlement preserve the generation and reading
position. Rehydrating the same history retires the previous view lifetime; reading
positions are not persisted across hydration.

The classic interface is a lazy derived projection of the same source. When no
classic view observes it, fullscreen updates do not maintain a second renderer's
transcript. Its Markdown
prefix promotion is an output optimization, not a second writable transcript.
Reasoning can fold visually across model steps while the source entries retain
their individual identities.

## Streaming and identity

A response keeps one source ID from its first accepted text through settlement.
Accepted provider text belongs to the source; pacing chooses the prefix visible
to a reader. The pacer stores cursor and timing state and reads source text by
reference. Finalization retains that ID. A queued reveal callback from a
replaced document must not append text to the next conversation.

Each `InkStreamingRenderer` captures a document lease. Replacing or clearing the
document retires it: late text, tool completion, turn completion, or buffered
timer work is ignored. Construct a new renderer for work on the replacement
document. A saved entry keeps its ID; newly generated IDs use a store-instance
namespace so a new process cannot collide with hydrated history.

Child renderer lifecycle events own their region and feed. Starting, flushing,
resetting, or completing a child cannot finalize the main answer or replace its
activity, model, prompt-context count, retry state, or expanded detail. Child
usage and cost still contribute to session totals. The main renderer owns the
main footer's current model and context.

The durable snapshot includes accepted partial response text. After resume it
is ordinary settled history: no provider stream or approval continuation is
restarted. Message-only histories derive deterministic per-document entries for
user and assistant turns, skipping system, tool protocol, empty, and continuation
messages.

## History version 3

UI records now store `{ id, content, timestamp }`. Strict schemas validate
content variants, report rows, dates, numeric statistics, and allowed fields at
the storage boundary. Duplicate source IDs are rejected before a save creates a
log. Readers accept a UI event as one batch: an invalid entry, repeated ID within
the batch, or append ID already in the current document rejects the whole event.
The previous valid UI document and model-facing messages remain available.
Source facts are immutable; fingerprint caching relies on that contract.

Version 2 UI records contain rendered `{ type, message }` text. They cannot
recover original receipt facts. Readers restore user entries as user text and
other output as historical notices, stripping terminal styling. Legacy decoding
requires a version 2 header; standalone line parsing defaults to strict version 3.
A malformed semantic entry is never reinterpreted as legacy text. Parseable
legacy timestamps become ISO instants; unreadable timestamps use the Unix epoch.
The next save
atomically upgrades their header and UI records while preserving model-facing
and unreadable records. IDs assigned during migration survive later compaction
of superseded UI snapshots. Repeating the upgrade is a no-op.

A save appends newly added entries. If any earlier saved fact changes, a fresh
UI snapshot supersedes the old presentation. This comparison checks the whole
saved prefix, including cases where the last entry is unchanged. Model-facing
messages remain separate and presentation entries are never sent to the model.

Older Jazz versions cannot open version 3 logs. Update Jazz before sharing a
conversation with an older installation. Existing model messages are retained;
there is no automatic recovery of structured facts from old painted text.

## Turn throughput

The closing turn receipt includes `N tok/s` when every output-bearing step has
measured generation timing. It divides total completion tokens by total decode
time, excluding tool execution and time before the first token. It does not
average per-step rates. Missing timing omits throughput instead of substituting
wall-clock turn time. Accepted timing and token counts persist with the receipt,
so resume uses the same calculation.

Source: [turn receipt](../../packages/cli/src/presentation/turn-receipt.ts) and
[formatter tests](../../packages/cli/src/presentation/turn-receipt.test.ts).

## Verification

Run the adjacent document, hydration, boundary-schema, conversation-log, and
turn-receipt tests. Important failures include source duplication at settlement,
late work after document replacement, reasoning identity loss, changed earlier
facts, duplicate IDs, invalid persisted UI fields, and repeated legacy migration.
Use the [terminal oracle](./terminal-rendering-tests.md) to separately verify
that a correct projected document produces the intended terminal grid.
