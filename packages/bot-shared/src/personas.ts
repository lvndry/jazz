/**
 * Persona discovery for the `/persona` picker, shared by the Discord and
 * Telegram bridges.
 *
 * Goes through `@jazz/adapters`'s `PersonaServiceImpl` — the same
 * builtin+custom scanning, frontmatter validation, and summarizer exclusion
 * the CLI itself uses — rather than each bridge hand-rolling a directory
 * scan. The only bridge-specific bit is where built-ins live on disk: each
 * bridge's container image copies them to a fixed path
 * (`JAZZ_BUILTIN_PERSONAS_DIR`) rather than relying on package-relative
 * resolution, which doesn't hold up inside these containers.
 */

import { BUILTIN_PERSONA_NAMES, PersonaServiceImpl } from "@jazz/adapters/persona-service";
import type { Persona } from "@jazz/core/types/persona";
import { Effect } from "effect";

export async function listPersonaNames(
  jazzHome: string,
  builtinPersonasDir: string,
): Promise<string[]> {
  const service = new PersonaServiceImpl({ baseDataPath: jazzHome, builtinPersonasDir });
  const personas = await Effect.runPromise(
    service.listPersonas().pipe(Effect.catchAll(() => Effect.succeed<readonly Persona[]>([]))),
  );
  const names = [...new Set(personas.map((persona) => persona.name))].filter(
    (name) => name !== "summarizer",
  );
  if (names.length === 0) {
    return [...BUILTIN_PERSONA_NAMES];
  }
  return names.sort((left, right) => left.localeCompare(right));
}
