/**
 * @fileoverview Back-compatible re-export of the webhook types.
 *
 * `TriggerConfig` was renamed to `WebhookConfig` because "trigger" already named an
 * unrelated feature — see `webhook.ts`. This alias exists so an out-of-tree import does not
 * break on upgrade, and so the rename can be finished in one place rather than negotiated
 * with every caller at once.
 */

export type {
  WebhookConfig as TriggerConfig,
  WebhookConversationMode as TriggerConversationMode,
} from "./webhook";
export {
  WEBHOOK_THREAD_HEADER as TRIGGER_THREAD_HEADER,
  MAX_WEBHOOK_THREAD_KEY_LENGTH as MAX_TRIGGER_THREAD_KEY_LENGTH,
} from "./webhook";
