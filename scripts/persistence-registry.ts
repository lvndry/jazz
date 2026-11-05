/**
 * Every durable store Jazz writes under its home and reads back across versions: the name used
 * for its snapshot and changelog files, where the version lives, and the declarations whose text
 * is its shape. `gen-persistence-snapshots.ts` derives a snapshot from this list; the gate in
 * `persistence-gate.ts` compares it with the checked-in one.
 *
 * A store with no `declarations` has a gap: its shape is not a type or schema the gate can read,
 * so only its version is tracked. A store whose version is `unversioned` has no format version
 * today; the gate records that explicitly instead of inventing one.
 */

export interface DeclarationReference {
  /** Path from the repository root. */
  readonly file: string;
  /** Name of a top-level interface, type alias, const, class or enum. */
  readonly symbol: string;
}

export type VersionSource =
  | { readonly kind: "constant"; readonly file: string; readonly symbol: string }
  | {
      readonly kind: "property";
      readonly file: string;
      readonly symbol: string;
      readonly property: string;
    }
  | { readonly kind: "unversioned"; readonly reason: string };

export interface PersistedStore {
  readonly name: string;
  /** Where the store lives, relative to the Jazz home. */
  readonly location: string;
  readonly version: VersionSource;
  readonly declarations: readonly DeclarationReference[];
  /** Why the shape cannot be snapshotted mechanically; present exactly when `declarations` is empty. */
  readonly gap?: string;
}

const CONVERSATION_LOG = "packages/adapters/src/history/conversation-log.ts";
const CONVERSATION_TREE = "packages/adapters/src/history/conversation-tree.ts";
const GOAL_RECORD = "packages/core/src/agent/goal/goal-record.ts";
const LOOP_RECORD = "packages/core/src/agent/loop/loop-record.ts";
const RUN_RECORD = "packages/core/src/agent/run/run-record.ts";
const RUN_STORE = "packages/adapters/src/storage/run-store.ts";
const SPEND_LEDGER = "packages/core/src/spend/ledger.ts";
const JOB_QUEUE_INTERFACE = "packages/core/src/interfaces/job-queue-service.ts";
const JOB_QUEUE_SERVICE = "packages/adapters/src/job-queue-service.ts";
const WAKE_TRIGGER_INTERFACE = "packages/core/src/interfaces/wake-trigger-service.ts";
const WAKE_TRIGGER_SERVICE = "packages/adapters/src/wake-trigger-service.ts";
const REMINDER_INTERFACE = "packages/core/src/interfaces/reminder-service.ts";
const REMINDER_SERVICE = "packages/adapters/src/reminder-service.ts";
const OUTBOX = "packages/core/src/notify/outbox.ts";
const RUN_HISTORY = "packages/core/src/workflows/run-history.ts";
const DAEMON_ATTENTION = "packages/core/src/daemon/attention.ts";
const CONFIG_SCHEMA = "packages/core/src/utils/config-schema.ts";
const SAVED_SECRETS = "packages/core/src/interfaces/saved-secrets.ts";
const PLUGIN_STATE_STORE = "packages/adapters/src/plugins/state-store.ts";
const PLUGIN_MANIFEST = "packages/adapters/src/plugins/manifest-schema.ts";
const PLUGIN_TYPES = "packages/core/src/types/plugin.ts";
const JAZZ_STATE = "packages/adapters/src/jazz-state.ts";
const OCCUPANCY = "packages/adapters/src/occupancy.ts";
const OCCUPANCY_TYPES = "packages/core/src/types/occupancy.ts";
const COMMAND_APPROVALS = "packages/adapters/src/command-approval-tracker.ts";
const MEMORY_SUGGESTIONS = "packages/adapters/src/memory-suggestions.ts";
const REFLECTION_WATERMARK = "packages/adapters/src/reflection-watermark.ts";
const SOURCE_LEDGER = "packages/adapters/src/memory-source-ledger.ts";
const WEBHOOK_DELIVERIES = "packages/adapters/src/webhooks/deliveries.ts";
const TOKEN_CALIBRATION = "packages/core/src/agent/context/token-calibration-state.ts";
const WORK_STATE = "packages/core/src/agent/context/work-state.ts";
const COMPUTER_GRANTS = "packages/core/src/agent/tools/computer/grants.ts";
const PEER_INTERFACE = "packages/core/src/interfaces/peers.ts";
const DETACH_JOB = "packages/adapters/src/detach/job.ts";
const DETACH_SNAPSHOT = "packages/adapters/src/detach/snapshot.ts";
const MEMORY_RECEIPTS = "packages/core/src/agent/memory-opportunity-receipts.ts";
const PROCESS = "packages/core/src/utils/process.ts";

function declarations(
  file: string,
  ...symbols: readonly string[]
): readonly DeclarationReference[] {
  return symbols.map((symbol) => ({ file, symbol }));
}

export const PERSISTED_STORES: readonly PersistedStore[] = [
  {
    name: "conversation-log",
    location: "history/<agentId>/<conversationId>.jsonl",
    version: { kind: "constant", file: CONVERSATION_LOG, symbol: "CONVERSATION_LOG_VERSION" },
    declarations: [
      ...declarations(
        CONVERSATION_LOG,
        "ConversationLogHeader",
        "ConversationLogMessage",
        "ConversationLogContext",
        "ConversationLogLeaf",
        "ConversationLogMeta",
        "ConversationLogRewrite",
        "ConversationLogUiTranscript",
        "ConversationLogUiAppend",
        "ConversationLogUiUpdate",
        "ConversationLogUiReset",
        "ConversationLogEvent",
      ),
      ...declarations(CONVERSATION_TREE, "KeepRun"),
    ],
  },
  {
    name: "goal-record",
    location: "goals/<goalId>.json",
    version: {
      kind: "unversioned",
      reason: "`version` is a compare-and-set revision counter, not a format version",
    },
    declarations: declarations(
      GOAL_RECORD,
      "goalRecordSchema",
      "GoalRecord",
      "GoalPlan",
      "GoalPlanStep",
      "GoalBudget",
      "GoalUsage",
      "GoalCycle",
      "GoalEvidenceItem",
    ),
  },
  {
    name: "loop-record",
    location: "loops/<loopId>.json",
    version: {
      kind: "unversioned",
      reason: "`version` is a compare-and-set revision counter, not a format version",
    },
    declarations: declarations(LOOP_RECORD, "LoopRecord"),
  },
  {
    name: "run-record",
    location: "runs/<runId>.json",
    version: {
      kind: "property",
      file: RUN_STORE,
      symbol: "RUN_RECORD_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(RUN_RECORD, "RunRecord"),
  },
  {
    name: "spend-summary",
    location: "spend/summary.json",
    version: { kind: "constant", file: SPEND_LEDGER, symbol: "SUMMARY_SCHEMA_VERSION" },
    declarations: declarations(SPEND_LEDGER, "TotalsSchema", "DaySpendSchema"),
  },
  {
    name: "spend-days",
    location: "spend/days/<YYYY-MM-DD>.jsonl",
    version: { kind: "unversioned", reason: "append-only day files carry no version stamp" },
    declarations: declarations(SPEND_LEDGER, "SpendEntrySchema"),
  },
  {
    name: "job-batch",
    location: "job-batches/<agentId>/<batchId>.json",
    version: { kind: "constant", file: JOB_QUEUE_SERVICE, symbol: "JOB_BATCH_SCHEMA_VERSION" },
    declarations: declarations(JOB_QUEUE_INTERFACE, "JobBatchRecordSchema"),
  },
  {
    name: "wake-trigger",
    location: "wake-triggers/<agentId>.json",
    version: {
      kind: "constant",
      file: WAKE_TRIGGER_SERVICE,
      symbol: "WAKE_TRIGGER_SCHEMA_VERSION",
    },
    declarations: declarations(WAKE_TRIGGER_INTERFACE, "WakeTriggerRecordSchema"),
  },
  {
    name: "reminder",
    location: "reminders/<agentId>.json",
    version: { kind: "constant", file: REMINDER_SERVICE, symbol: "REMINDER_SCHEMA_VERSION" },
    declarations: declarations(REMINDER_INTERFACE, "ReminderRecordSchema"),
  },
  {
    name: "notify-outbox",
    location: "notify/outbox/<target>.json",
    version: { kind: "constant", file: OUTBOX, symbol: "OUTBOX_SCHEMA_VERSION" },
    declarations: declarations(OUTBOX, "OutboxItemSchema"),
  },
  {
    name: "notify-dedupe",
    location: "notify/sent.json",
    version: { kind: "property", file: OUTBOX, symbol: "DEDUPE_KIND", property: "schemaVersion" },
    declarations: declarations(OUTBOX, "DedupeLog"),
  },
  {
    name: "workflow-run-history",
    location: "run-history.json",
    version: { kind: "constant", file: RUN_HISTORY, symbol: "RUN_HISTORY_SCHEMA_VERSION" },
    declarations: declarations(RUN_HISTORY, "WorkflowRunRecordSchema", "ProcessOwnerSchema"),
  },
  {
    name: "daemon-state",
    location: "daemon-state.json",
    version: { kind: "unversioned", reason: "read leniently: an unreadable file reads as empty" },
    declarations: declarations(DAEMON_ATTENTION, "DaemonState"),
  },
  {
    name: "config",
    location: "config.json",
    version: { kind: "unversioned", reason: "strict schema with no version stamp" },
    declarations: declarations(CONFIG_SCHEMA, "configFileShape", "ConfigFileSchema"),
  },
  {
    name: "secrets-file",
    location: "secrets.json",
    version: {
      kind: "unversioned",
      reason: "free-form name-to-value map used when no OS keyring exists",
    },
    declarations: [],
    gap: "free-form map of secret names to values; no declared shape",
  },
  {
    name: "saved-secrets-index",
    location: "saved-secrets.json",
    version: { kind: "unversioned", reason: "index parsed field by field with no version stamp" },
    declarations: declarations(SAVED_SECRETS, "SavedSecretEntry"),
  },
  {
    name: "plugin-state",
    location: "plugins registry: lock records, trusted digests, consent grants",
    version: { kind: "constant", file: PLUGIN_STATE_STORE, symbol: "PLUGIN_STATE_SCHEMA_VERSION" },
    declarations: [
      ...declarations(
        PLUGIN_STATE_STORE,
        "PluginStateDocument",
        "PluginStateRecord",
        "PluginLockRecord",
      ),
      ...declarations(PLUGIN_TYPES, "PluginConsentGrant"),
    ],
  },
  {
    name: "plugin-manifest",
    location: "plugin.json inside each installed plugin",
    version: {
      kind: "constant",
      file: PLUGIN_MANIFEST,
      symbol: "PLUGIN_MANIFEST_SCHEMA_VERSION",
    },
    declarations: [],
    gap: "manifest is validated by hand-written field checks, not a declared type or schema",
  },
  {
    name: "bot-state",
    location: "state.json (per bot conversation home)",
    version: {
      kind: "property",
      file: JAZZ_STATE,
      symbol: "JAZZ_STATE_FILE_KIND",
      property: "schemaVersion",
    },
    declarations: [],
    gap: "typed as Record<string, unknown>; each caller owns its own keys",
  },
  {
    name: "bot-occupancy",
    location: "occupancy.json",
    version: {
      kind: "property",
      file: OCCUPANCY,
      symbol: "OCCUPANCY_FILE_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(OCCUPANCY_TYPES, "OccupancyEntry", "OccupancyRunState"),
  },
  {
    name: "command-approvals",
    location: "command-approvals.json",
    version: {
      kind: "property",
      file: COMMAND_APPROVALS,
      symbol: "COMMAND_APPROVALS_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(COMMAND_APPROVALS, "CommandApprovalRecord", "CommandApprovals"),
  },
  {
    name: "memory-entries",
    location: "memory/<scope>/**/*.md",
    version: {
      kind: "unversioned",
      reason: "markdown files with frontmatter and no version stamp",
    },
    declarations: [],
    gap: "markdown with frontmatter parsed by hand; no declared shape",
  },
  {
    name: "memory-suggestions",
    location: "memory/.pending-memory.json",
    version: {
      kind: "property",
      file: MEMORY_SUGGESTIONS,
      symbol: "SUGGESTION_QUEUE_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(MEMORY_SUGGESTIONS, "SuggestionQueue"),
  },
  {
    name: "memory-reflection-watermark",
    location: "memory/.reflected-conversations.json",
    version: {
      kind: "property",
      file: REFLECTION_WATERMARK,
      symbol: "WATERMARK_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(REFLECTION_WATERMARK, "ReflectionWatermarks"),
  },
  {
    name: "memory-source-ledger",
    location: "memory/.source-ledger.json",
    version: {
      kind: "property",
      file: SOURCE_LEDGER,
      symbol: "SOURCE_LEDGER_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(SOURCE_LEDGER, "SourceLedger"),
  },
  {
    name: "memory-receipts",
    location: "memory-receipts/**",
    version: { kind: "unversioned", reason: "receipt files carry no version stamp" },
    declarations: declarations(MEMORY_RECEIPTS, "MemoryExposureRecord", "MemoryOpportunityReceipt"),
  },
  {
    name: "webhook-deliveries",
    location: "webhooks/deliveries/<webhook>.json",
    version: {
      kind: "property",
      file: WEBHOOK_DELIVERIES,
      symbol: "DELIVERIES_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(WEBHOOK_DELIVERIES, "DELIVERIES_KIND"),
  },
  {
    name: "token-calibration",
    location: "token-calibration.json",
    version: {
      kind: "property",
      file: TOKEN_CALIBRATION,
      symbol: "TOKEN_CALIBRATION_KIND",
      property: "schemaVersion",
    },
    declarations: declarations(TOKEN_CALIBRATION, "TokenCalibrationState"),
  },
  {
    name: "work-state",
    location: "work/<agentId>/<conversationId>/state.json",
    version: { kind: "unversioned", reason: "no version stamp" },
    declarations: declarations(WORK_STATE, "WorkState"),
  },
  {
    name: "computer-grants",
    location: "computer/grants.json",
    version: {
      kind: "property",
      file: COMPUTER_GRANTS,
      symbol: "computerStateSchema",
      property: "version",
    },
    declarations: declarations(
      COMPUTER_GRANTS,
      "computerStateSchema",
      "grantSchema",
      "acknowledgementSchema",
    ),
  },
  {
    name: "peer-ledger",
    location: "peers/ledger.jsonl",
    version: { kind: "unversioned", reason: "append-only entries carry no version stamp" },
    declarations: declarations(PEER_INTERFACE, "LedgerEntry", "LedgerOutcome"),
  },
  {
    name: "chat-attachments",
    location: "chat-attachments/<agentId>/<conversationId>.json",
    version: { kind: "unversioned", reason: "a bare process owner object with no version stamp" },
    declarations: declarations(PROCESS, "ProcessOwner"),
  },
  {
    name: "detach-job",
    location: "detached job record (one file per job)",
    version: {
      kind: "property",
      file: DETACH_JOB,
      symbol: "DetachedJobRecord",
      property: "version",
    },
    declarations: declarations(DETACH_JOB, "DetachedJobRecord", "DetachedJobStatus"),
  },
  {
    name: "detach-manifest",
    location: "detach snapshot manifest",
    version: {
      kind: "property",
      file: DETACH_SNAPSHOT,
      symbol: "DetachManifest",
      property: "version",
    },
    declarations: declarations(
      DETACH_SNAPSHOT,
      "DetachManifest",
      "DetachEntry",
      "DetachEntryKind",
      "DETACH_ENTRY_KINDS",
    ),
  },
];
