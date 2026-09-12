---
description: "Understand Jazz runtime files, conversation and run persistence, JSON output envelopes, streaming events, logs, workspaces, and data directories."
---

# Jazz runtime contracts and data

These contracts matter when you integrate Jazz with another program or debug a run.

- [Headless runs](../surfaces/headless.md) defines stdin, stdout, stderr, JSON, events, and exit behavior.
- [Conversations and memory](../concepts/conversations-and-memory.md) explains the different kinds of retained state.
- [Jazz configuration](../configure/jazz.md) defines `JAZZ_HOME`, project overrides, and storage settings.
- [Run lifecycle](../maintainers/run-lifecycle.md) shows when results and transcripts are finalized.

Do not depend on an undocumented file path or internal JSON shape. If an integration needs a stable contract, document and test it here first.
