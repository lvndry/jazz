---
description: "Portable snapshot contents and ownership fencing for remote conversation handoff."
---

# Remote handoff snapshot

`createDetachSnapshot` in [`snapshot.ts`](../../packages/adapters/src/detach/snapshot.ts) writes a directory containing `manifest.json` and `files/<relativePath>` for each manifest entry. The manifest records byte length and SHA-256 for every file. An importer checks the complete bundle before it clones or writes any destination file.

The snapshot contains the conversation transcript, its per-conversation work directory and todo file, one Git bundle of `HEAD`, and tracked plus non-ignored untracked workspace files. It also carries the selected agent definition with `llmApiKeys` removed. It does not copy global Jazz config, credentials, installed skills, memory, or generated files. Custom personas, custom tools, installed custom Jazz skills, and transcripts referencing generated artifacts stop export until their dependencies can be scoped and transferred safely. A workspace must be a Git repository with a commit; ignored files and paths outside its root stay on the source machine. The Git bundle contains commit history, which may include files no longer present in the working tree.

`prepareDetach` in [`ownership.ts`](../../packages/core/src/agent/detach/ownership.ts) records a durable local fence. Both `preparing` and `remote` reject a new local agent run or conversation save. Snapshot creation must finish before preparation when it is given in-memory history, because it strictly saves that history first. A failed transfer may call `abortDetach` only while preparing. A committed handoff cannot be rolled back by losing SSH connectivity; the remote may be running. The remote host imports into its own Jazz home and a dedicated empty workspace, then starts a continuation under the same `(agentId, conversationId)`.
