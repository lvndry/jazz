import { Context, type Effect } from "effect";

/** One secret a person saved for every agent on this Jazz home. Never carries the value. */
export interface SavedSecretEntry {
  readonly name: string;
  /** What the secret is for, as the person or the asking agent described it. */
  readonly description: string;
  readonly savedAt: string;
}

/**
 * Typed secrets kept across runs: values in the OS keyring (or the `secrets.json` fallback),
 * names in an index beside it so agents can see what exists without reading any value.
 */
export interface SavedSecretsService {
  readonly list: Effect.Effect<readonly SavedSecretEntry[]>;
  /** The value saved under `name`, or undefined when there is none. */
  readonly read: (name: string) => Effect.Effect<string | undefined>;
  /** Save `value` under `name`, replacing any earlier one. False when nothing could store it. */
  readonly save: (name: string, value: string, description: string) => Effect.Effect<boolean>;
  /** Forget `name`. False when nothing was saved under it. */
  readonly remove: (name: string) => Effect.Effect<boolean>;
  /** Where values are kept, for messages: "the macOS keychain". */
  readonly storageDescription: Effect.Effect<string>;
}

export const SavedSecretsServiceTag =
  Context.GenericTag<SavedSecretsService>("SavedSecretsService");
