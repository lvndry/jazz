/**
 * Implements `WorkflowRegistryService`: the workflow half of the library.
 *
 * Fetching, caching, and the origin check live in `LibraryCatalog`; this
 * module adds what makes an entry a workflow (its schedule and autonomy tier in
 * the index) and checks a downloaded `WORKFLOW.md` with the same parser the
 * local loaders use, so an install can never produce a file `jazz workflow list`
 * would then refuse to show.
 */

import {
  WorkflowRegistryServiceTag,
  type WorkflowRegistryService,
} from "@jazz/core/interfaces/workflow-registry";
import { NetworkError, ValidationError } from "@jazz/core/types/errors";
import type {
  RegistryWorkflowDownload,
  RegistryWorkflowEntry,
} from "@jazz/core/types/workflow-registry";
import { parseAutoApprove, parseWorkflowDefinition } from "@jazz/core/workflows/workflow-service";
import { Effect, Layer } from "effect";
import matter from "gray-matter";
import { LibraryCatalog, optionalString } from "./library-catalog";

/** A prompt past this is a publishing mistake, not a workflow anyone meant to share. */
const MAX_PROMPT_LENGTH = 50_000;

export interface WorkflowRegistryServiceImplOptions {
  /** Override the library base URL. Default: JAZZ_LIBRARY_URL, else the public site. */
  readonly baseUrl?: string;
  /** Override the directory the index snapshot is mirrored to. Default: `<jazz home>/cache`. */
  readonly cacheDir?: string;
}

export class WorkflowRegistryServiceImpl implements WorkflowRegistryService {
  private readonly catalog: LibraryCatalog<RegistryWorkflowEntry>;

  constructor(options?: WorkflowRegistryServiceImplOptions) {
    this.catalog = new LibraryCatalog<RegistryWorkflowEntry>({
      kind: "workflow",
      collection: "workflows",
      cacheFile: "workflow-registry.json",
      browseCommand: "jazz workflow browse",
      parseEntry: (record, base) => {
        const schedule = optionalString(record["schedule"]);
        const autoApprove = parseAutoApprove(record["autoApprove"]);
        return {
          ...base,
          ...(schedule !== undefined && { schedule }),
          ...(autoApprove !== undefined && { autoApprove }),
        };
      },
      baseUrl: options?.baseUrl,
      cacheDir: options?.cacheDir,
    });
  }

  listEntries(options?: {
    readonly refresh?: boolean;
  }): Effect.Effect<readonly RegistryWorkflowEntry[], NetworkError> {
    return this.catalog.listEntries(options);
  }

  fetchWorkflow(
    name: string,
  ): Effect.Effect<RegistryWorkflowDownload, NetworkError | ValidationError> {
    return Effect.gen(
      function* (this: WorkflowRegistryServiceImpl) {
        const { entry, sourceUrl, markdown } = yield* this.catalog.fetchEntry(name);

        const parsed = matter(markdown);
        const definition = parseWorkflowDefinition(parsed.data);
        const prompt = parsed.content.trim();

        if (definition === null) {
          return yield* Effect.fail(
            new ValidationError({
              field: "frontmatter",
              message: `Library workflow "${entry.name}" is not a workflow Jazz can run: its frontmatter must declare name and description`,
              value: sourceUrl,
              suggestion: "Report this catalog entry.",
            }),
          );
        }

        if (prompt.length === 0) {
          return yield* Effect.fail(
            new ValidationError({
              field: "prompt",
              message: `Library workflow "${entry.name}" has an empty prompt`,
              value: sourceUrl,
              suggestion: "Report this catalog entry — it was published without a prompt body.",
            }),
          );
        }

        if (prompt.length > MAX_PROMPT_LENGTH) {
          return yield* Effect.fail(
            new ValidationError({
              field: "prompt",
              message: `Library workflow "${entry.name}" exceeds the ${MAX_PROMPT_LENGTH}-character prompt limit`,
              value: `(${prompt.length} chars)`,
              suggestion: "Report this catalog entry — Jazz will not install a prompt this large.",
            }),
          );
        }

        return { entry, sourceUrl, markdown, definition, prompt };
      }.bind(this),
    );
  }
}

// ─── Layer ───────────────────────────────────────────────────────────────────

export function createWorkflowRegistryServiceLayer(): Layer.Layer<WorkflowRegistryService> {
  return Layer.succeed(WorkflowRegistryServiceTag, new WorkflowRegistryServiceImpl());
}
