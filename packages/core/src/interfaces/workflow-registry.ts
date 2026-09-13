/**
 * `WorkflowRegistryService` interface for reading the workflow library — a
 * remote, git-backed catalog of shareable workflows that users can install into
 * `~/.jazz/workflows/`.
 */
import { Context, Effect } from "effect";
import type { NetworkError, ValidationError } from "@/core/types/errors";
import type {
  RegistryWorkflowDownload,
  RegistryWorkflowEntry,
} from "@/core/types/workflow-registry";

export interface WorkflowRegistryService {
  /**
   * List every workflow advertised by the library.
   *
   * Served from a disk snapshot while it is fresh, and falls back to the last
   * snapshot when the network is unreachable or Jazz is running offline.
   *
   * @param options.refresh - Bypass the cached snapshot and re-fetch the index
   * @returns An Effect resolving to the catalog entries, sorted by name
   */
  readonly listEntries: (options?: {
    readonly refresh?: boolean;
  }) => Effect.Effect<readonly RegistryWorkflowEntry[], NetworkError>;

  /**
   * Download one workflow's full `WORKFLOW.md`, validated as a definition Jazz can run.
   *
   * @param name - Catalog name of the workflow to download
   * @returns An Effect resolving to the downloaded workflow
   */
  readonly fetchWorkflow: (
    name: string,
  ) => Effect.Effect<RegistryWorkflowDownload, NetworkError | ValidationError>;
}

export const WorkflowRegistryServiceTag =
  Context.GenericTag<WorkflowRegistryService>("WorkflowRegistryService");
