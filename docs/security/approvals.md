---
description: "Control which Jazz agent tools run automatically, which require approval, and how shell commands are classified before execution."
---

# Jazz tool approvals and risk levels

Tool availability and tool approval are separate controls. Removing a tool prevents the model from requesting it. Approval policy decides whether an available tool may execute without asking.

Jazz uses `read-only`, `low-risk`, and `high-risk` policy levels. Tools above the active level are gated. `execute_command` receives a command-specific classification unless the run explicitly bypasses it.

Interactive surfaces can ask a person. Unattended surfaces decline gated calls by default. A headless caller may opt into parking so the run is persisted and later resumed after approval.

For exact tool classifications, see the [tool inventory](../tools/index.md). For the execution path, see the [tool lifecycle](../maintainers/tool-lifecycle.md).
