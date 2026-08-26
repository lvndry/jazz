/**
 * @fileoverview Shared interaction core for choice-based prompts.
 *
 * Re-exports the pure picker core and the ink binding so both renderers import
 * from one place. See `picker-core.ts` for the architecture and the drift
 * contract.
 */

export * from "./picker-core";
export * from "./use-picker";
export * from "./picker-adapter";
