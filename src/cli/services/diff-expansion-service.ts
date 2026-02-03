import { Effect, Context } from "effect";

// ============================================================================
// Types
// ============================================================================

/**
 * Diff expansion request information
 */
export interface DiffExpansionRequest {
  readonly originalContent: string;
  readonly newContent: string;
  readonly filepath: string;
  readonly options?: {
    readonly isNewFile?: boolean;
    readonly contextLines?: number;
  };
}

/**
 * Truncated diff information
 */
export interface TruncatedDiffInfo {
  readonly request: DiffExpansionRequest;
  readonly truncatedAtLine: number;
  readonly totalChanges: number;
  readonly timestamp: number;
}

// ============================================================================
// Service Interface
// ============================================================================

export interface DiffExpansionService {
  /**
   * Register a truncated diff for potential expansion
   */
  readonly registerTruncatedDiff: (info: TruncatedDiffInfo) => Effect.Effect<void>;

  /**
   * Get the most recent truncated diff that can be expanded
   */
  readonly getExpandableDiff: () => Effect.Effect<TruncatedDiffInfo | null>;

  /**
   * Clear the expandable diff (after expansion or when no longer needed)
   */
  readonly clearExpandableDiff: () => Effect.Effect<void>;

  /**
   * Check if there's currently a diff that can be expanded
   */
  readonly hasExpandableDiff: () => Effect.Effect<boolean>;
}

// ============================================================================
// Service Implementation
// ============================================================================

class DiffExpansionServiceImpl implements DiffExpansionService {
  private expandableDiff: TruncatedDiffInfo | null = null;

  readonly registerTruncatedDiff = (info: TruncatedDiffInfo): Effect.Effect<void> =>
    Effect.sync(() => {
      this.expandableDiff = info;
    });

  readonly getExpandableDiff = (): Effect.Effect<TruncatedDiffInfo | null> =>
    Effect.sync(() => this.expandableDiff);

  readonly clearExpandableDiff = (): Effect.Effect<void> =>
    Effect.sync(() => {
      this.expandableDiff = null;
    });

  readonly hasExpandableDiff = (): Effect.Effect<boolean> =>
    Effect.sync(() => this.expandableDiff !== null);
}

// ============================================================================
// Service Context
// ============================================================================

export const DiffExpansionServiceTag = Context.GenericTag<DiffExpansionService>(
  "cli/services/DiffExpansionService"
);

// ============================================================================
// Service Factory
// ============================================================================

export const makeDiffExpansionService: Effect.Effect<DiffExpansionService> = Effect.gen(
  function* () {
    return new DiffExpansionServiceImpl();
  }
);

// ============================================================================
// Service Helpers
// ============================================================================

/**
 * Register a truncated diff for potential expansion
 */
export const registerTruncatedDiff = (info: TruncatedDiffInfo) =>
  Effect.gen(function* () {
    const service = yield* DiffExpansionServiceTag;
    yield* service.registerTruncatedDiff(info);
  });

/**
 * Get the most recent truncated diff that can be expanded
 */
export const getExpandableDiff = () =>
  Effect.gen(function* () {
    const service = yield* DiffExpansionServiceTag;
    return yield* service.getExpandableDiff();
  });

/**
 * Clear the expandable diff (after expansion or when no longer needed)
 */
export const clearExpandableDiff = () =>
  Effect.gen(function* () {
    const service = yield* DiffExpansionServiceTag;
    yield* service.clearExpandableDiff();
  });

/**
 * Check if there's currently a diff that can be expanded
 */
export const hasExpandableDiff = () =>
  Effect.gen(function* () {
    const service = yield* DiffExpansionServiceTag;
    return yield* service.hasExpandableDiff();
  });
