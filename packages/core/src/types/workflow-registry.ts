/**
 * @fileoverview Workflow marketplace domain model types
 *
 * The marketplace is a git-backed catalog of shareable workflows: each entry is a
 * `WORKFLOW.md` under the website's marketplace content directory, published as
 * a static index plus one raw markdown file per workflow. Nothing here is
 * user-generated at runtime — entries land in the catalog through a pull request.
 */

import type { AutoApprovePolicy } from "@/core/types/tools";
import type { WorkflowDefinition } from "@/core/workflows/workflow-service";

/** One workflow as advertised by the marketplace index (metadata only, no prompt). */
export interface RegistryWorkflowEntry {
  /** Catalog name, unique within the registry. Also the default install name. */
  readonly name: string;
  /** Brief human-readable summary of what this workflow does. */
  readonly description: string;
  /** Cron expression the workflow ships with, when it is meant to be scheduled. */
  readonly schedule?: string;
  /** Autonomy tier the workflow asks for when it runs unattended. */
  readonly autoApprove?: AutoApprovePolicy;
  /** Who contributed the workflow. */
  readonly author?: string;
  /** Free-form tags used for search and filtering. */
  readonly tags?: readonly string[];
  /**
   * Location of the raw `WORKFLOW.md`, absolute or relative to the registry base URL.
   * Resolved against the base and rejected if it escapes that origin.
   */
  readonly url: string;
}

/** The marketplace index document served at `<registry base>/workflows.json`. */
export interface WorkflowRegistryIndex {
  /** Index schema version. Bumped when the entry shape changes incompatibly. */
  readonly version: number;
  readonly workflows: readonly RegistryWorkflowEntry[];
}

/**
 * A workflow downloaded from the marketplace: the catalog entry it came from, the
 * `WORKFLOW.md` exactly as published, the frontmatter Jazz parsed out of it, and
 * the URL it was read from so the CLI can show the user exactly what they are
 * about to trust.
 */
export interface RegistryWorkflowDownload {
  readonly entry: RegistryWorkflowEntry;
  readonly sourceUrl: string;
  readonly markdown: string;
  readonly definition: WorkflowDefinition;
  readonly prompt: string;
}
