/**
 * @fileoverview Named companions: reusable companion definitions, and how a role binding resolves.
 *
 * An agent binds a companion role (`"analyze:image"`) to one of two things:
 * - a `"provider/model"` id, which runs that model with the provider's global URL and key;
 * - the name of an entry under the global config's `companions`, which carries its own server
 *   address, credential, declared media input and fixed prompt.
 *
 * The two never collide: a name may not contain `/`, so anything with one is a model id. A name
 * is also a config path segment (`companions.<name>.api_key` lives in the keyring) and an env var
 * suffix (`JAZZ_COMPANION_API_KEY_<NAME>`), so it is restricted to letters, digits, `-` and `_`.
 *
 * - `isCompanionName` / `isCompanionBinding` check syntax only, for validating agent files,
 *   which never see the global config.
 * - `resolveCompanionBinding` turns a binding into the model to run, or an error that says how
 *   to fix it. Whether a name exists is only knowable here, at use time.
 */

import type { ProviderName } from "@/core/constants/models";
import type { AttachmentKind } from "@/core/types/attachment";
import type { AppConfig, NamedCompanionConfig } from "@/core/types/config";
import { parseProviderModel } from "./provider-model";

const COMPANION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Whether `value` is a well-formed companion name (not whether one is defined). */
export function isCompanionName(value: string): boolean {
  return COMPANION_NAME_PATTERN.test(value);
}

/** Whether `value` can bind a role: a known `"provider/model"` id or a companion name. */
export function isCompanionBinding(value: string): boolean {
  return parseProviderModel(value) !== null || isCompanionName(value);
}

/** The model a binding runs, and what a named definition adds to it. */
export interface CompanionTarget {
  /** The binding as written, which is what gets saved back to the agent. */
  readonly binding: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** Media the companion declares it reads; absent means the model catalog decides. */
  readonly accepts?: readonly AttachmentKind[];
  /** Fixed analysis prompt replacing the delegation brief. */
  readonly prompt?: string;
}

export type CompanionResolution =
  | { readonly ok: true; readonly target: CompanionTarget }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a binding against the global `companions` definitions.
 *
 * A `"provider/model"` id resolves on its own. A name must be defined in the global config;
 * an undefined one is an error naming the entry to add rather than a silent fallback, because
 * a binding is the operator's consent to send media to that specific server.
 */
export function resolveCompanionBinding(
  binding: string,
  companions: AppConfig["companions"],
): CompanionResolution {
  const parsed = parseProviderModel(binding);
  if (parsed !== null) {
    return { ok: true, target: { binding, provider: parsed.provider, model: parsed.model } };
  }
  if (!isCompanionName(binding)) {
    return {
      ok: false,
      error: `"${binding}" is neither a provider/model id nor a companion name.`,
    };
  }
  const definition: NamedCompanionConfig | undefined =
    companions !== undefined && Object.hasOwn(companions, binding)
      ? companions[binding]
      : undefined;
  if (definition === undefined) {
    return {
      ok: false,
      error: `No companion named "${binding}" is defined. Add it under "companions" in ~/.jazz/config.json (project config cannot define companions).`,
    };
  }
  return {
    ok: true,
    target: {
      binding,
      provider: definition.provider,
      model: definition.model,
      ...(definition.base_url !== undefined ? { baseUrl: definition.base_url } : {}),
      ...(definition.api_key !== undefined ? { apiKey: definition.api_key } : {}),
      ...(definition.accepts !== undefined ? { accepts: definition.accepts } : {}),
      ...(definition.prompt !== undefined ? { prompt: definition.prompt } : {}),
    },
  };
}
