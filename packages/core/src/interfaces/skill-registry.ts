/**
 * `SkillRegistryService` is the port for the reviewed marketplace skill
 * catalog. Adapters own HTTP, caching, origin validation, and markdown
 * validation; CLI commands only consume this safe, typed contract.
 */
import { Context, Effect } from "effect";
import type { NetworkError, ValidationError } from "@/core/types/errors";
import type { RegistrySkillDownload, RegistrySkillEntry } from "@/core/types/skill-registry";

export interface SkillRegistryService {
  /**
   * List marketplace skills, using a fresh disk snapshot when available and
   * falling back to the last snapshot when offline or unreachable.
   */
  readonly listEntries: (options?: {
    readonly refresh?: boolean;
  }) => Effect.Effect<readonly RegistrySkillEntry[], NetworkError>;

  /**
   * Download and validate one catalog skill. The returned markdown is the
   * published single file and is never interpreted as executable code.
   */
  readonly fetchSkill: (
    name: string,
  ) => Effect.Effect<RegistrySkillDownload, NetworkError | ValidationError>;
}

export const SkillRegistryServiceTag =
  Context.GenericTag<SkillRegistryService>("SkillRegistryService");
