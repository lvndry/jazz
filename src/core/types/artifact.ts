/**
 * @fileoverview Files an agent produced during a run
 *
 * The counterpart to `MessageAttachment`, which carries files *into* a run. Both hold a path
 * rather than bytes, for the same reason: the file already exists on disk and copying it into a
 * message or a JSON envelope only makes both larger.
 *
 * Every producer declares its artifacts rather than a consumer recognizing them by tool name.
 * The alternative — what jazz did before this — was `extractWebAppResult` looking up
 * `toolResults["create_web_app"]` and validating its exact shape, which meant every new producer
 * needed a branch in the runner, in the JSON envelope, and in every bridge.
 */

/** What kind of file this is, which is all a consumer needs to decide how to present it. */
export type ArtifactKind = "image" | "audio" | "video" | "pdf" | "html";

/**
 * How an artifact came to exist.
 *
 * This is a user-facing distinction, not an implementation detail. A chart rendered from HTML the
 * model wrote has exact numbers and reproduces byte-for-byte; an image from a generative model
 * has neither property and will happily invent an axis label. Presenting them identically tells
 * someone the numbers in a chart came from a model's imagination when they did not — or the
 * reverse, which is worse.
 *
 * Carried explicitly rather than inferred from `tool`, so no consumer has to maintain a list of
 * which tool names are which.
 */
export type ArtifactSource = "rendered" | "model";

export interface GeneratedArtifact {
  readonly kind: ArtifactKind;
  /** Absolute path on disk. */
  readonly path: string;
  /** Full IANA media type, e.g. "application/pdf". */
  readonly mediaType: string;
  /** Human-readable label, used when a surface wants a caption or filename. */
  readonly title?: string;
  /** Tool that produced it, for display and debugging. */
  readonly tool: string;
  readonly source: ArtifactSource;
}

const ARTIFACT_KINDS: ReadonlySet<string> = new Set<ArtifactKind>([
  "image",
  "audio",
  "video",
  "pdf",
  "html",
]);

const ARTIFACT_SOURCES: ReadonlySet<string> = new Set<ArtifactSource>(["rendered", "model"]);

/**
 * Validate a value a tool returned as an artifact.
 *
 * Tool results are typed `unknown` and custom/MCP tools can return anything, so this is the
 * boundary where a malformed artifact is dropped rather than propagated into the JSON envelope
 * that scripts and bridges consume.
 */
export function parseGeneratedArtifact(value: unknown): GeneratedArtifact | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;

  const { kind, path, mediaType, tool, source, title } = candidate;
  if (typeof kind !== "string" || !ARTIFACT_KINDS.has(kind)) return null;
  if (typeof source !== "string" || !ARTIFACT_SOURCES.has(source)) return null;
  if (typeof path !== "string" || path.length === 0) return null;
  if (typeof mediaType !== "string" || mediaType.length === 0) return null;
  if (typeof tool !== "string" || tool.length === 0) return null;

  return {
    kind: kind as ArtifactKind,
    path,
    mediaType,
    tool,
    source: source as ArtifactSource,
    ...(typeof title === "string" && title.length > 0 ? { title } : {}),
  };
}

/** Collect the valid artifacts out of whatever a tool returned, dropping malformed entries. */
export function parseGeneratedArtifacts(value: unknown): GeneratedArtifact[] {
  if (!Array.isArray(value)) return [];
  const artifacts: GeneratedArtifact[] = [];
  for (const entry of value) {
    const parsed = parseGeneratedArtifact(entry);
    if (parsed !== null) artifacts.push(parsed);
  }
  return artifacts;
}

/**
 * One-line description for the terminal.
 *
 * Names the provenance for anything a model produced, because "generated" is the word that tells
 * the reader not to trust the pixels the way they would trust a rendered chart. Rendered output
 * needs no such warning, so it stays quiet.
 */
export function describeArtifact(artifact: GeneratedArtifact): string {
  const label = artifact.title ?? artifact.kind;
  const provenance = artifact.source === "model" ? " (AI-generated)" : "";
  return `${label}${provenance}: ${artifact.path}`;
}
