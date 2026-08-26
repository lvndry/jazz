/**
 * Safe resolution of untrusted paths inside a fixed virtual filesystem root.
 *
 * Use this for tool paths where a leading slash names the virtual root rather
 * than the host filesystem root. Resolution rejects traversal and symlinks so
 * callers cannot escape the supplied root.
 */
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";

/**
 * Raised when a virtual path violates containment or syntax rules.
 *
 * Callers should branch with `instanceof VirtualPathViolation`, not message text.
 */
export class VirtualPathViolation extends Error {}

/** Limits applied while parsing a virtual path. */
export interface VirtualPathOptions {
  /** Maximum number of slash-separated path segments. */
  readonly maxDepth: number;
  /** Maximum UTF-16 length of any individual path segment. */
  readonly maxSegmentLength: number;
}

/**
 * Normalize and validate a virtual path into safe path segments.
 *
 * Leading slashes are virtual-root markers. Null bytes, backslashes, empty
 * segments, dot segments, and configured limit violations are rejected.
 *
 * @param virtualPath - Untrusted path supplied by a tool caller.
 * @param options - Depth and segment-length limits.
 * @returns NFC-normalized path segments.
 * @throws {@link VirtualPathViolation} when validation fails.
 */
export function splitVirtualPathIntoSegments(
  virtualPath: string,
  options: VirtualPathOptions,
): string[] {
  if (virtualPath.includes("\0")) {
    throw new VirtualPathViolation("Path contains a null byte.");
  }

  const normalized = virtualPath.normalize("NFC");
  const withoutLeadingSlashes = normalized.replace(/^\/+/, "");

  if (withoutLeadingSlashes.length === 0) return [];

  if (withoutLeadingSlashes.includes("\\")) {
    throw new VirtualPathViolation("Path must not contain backslashes.");
  }

  const segments = withoutLeadingSlashes.split("/");
  if (segments.length > options.maxDepth) {
    throw new VirtualPathViolation(
      `Path depth ${segments.length} exceeds the maximum of ${options.maxDepth}.`,
    );
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new VirtualPathViolation('Path must not contain empty segments ("//").');
    }
    if (segment === "." || segment === "..") {
      throw new VirtualPathViolation(`Path segment "${segment}" is not allowed.`);
    }
    if (segment.length > options.maxSegmentLength) {
      throw new VirtualPathViolation(
        `Path segment exceeds the maximum length of ${options.maxSegmentLength}.`,
      );
    }
  }

  return segments;
}

/** Identify Node's missing-path failure without swallowing other I/O errors. */
function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

/**
 * Check a path component without following the final symlink.
 *
 * A missing component is not a symlink; all other filesystem errors propagate.
 */
function isSymlink(candidatePath: string): Effect.Effect<boolean, Error> {
  return Effect.tryPromise({
    try: () => nodeFs.lstat(candidatePath),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.map((stat) => stat.isSymbolicLink()),
    Effect.catchIf(isMissingPathError, () => Effect.succeed(false)),
  );
}

/**
 * Resolve an untrusted virtual path beneath a fixed filesystem root.
 *
 * Every existing path component is checked for symlinks. The returned path is
 * normalized and remains beneath `root`; callers may then perform their file
 * operation against it.
 *
 * @param root - Trusted, absolute backing directory. The root itself must
 * already exist and is not checked for being a symlink.
 * @param virtualPath - Untrusted virtual path to resolve.
 * @param options - Parsing limits for the virtual path.
 * @returns An Effect containing the safe backing filesystem path.
 */
export function resolveVirtualPath(
  root: string,
  virtualPath: string,
  options: VirtualPathOptions,
): Effect.Effect<string, VirtualPathViolation | Error> {
  return Effect.gen(function* () {
    const segments = yield* Effect.try({
      try: () => splitVirtualPathIntoSegments(virtualPath, options),
      catch: (error) =>
        error instanceof VirtualPathViolation ? error : new VirtualPathViolation(String(error)),
    });

    const candidate = segments.length === 0 ? root : path.join(root, ...segments);
    const normalizedCandidate = path.normalize(candidate);
    const rootWithSeparator = root.endsWith(path.sep) ? root : root + path.sep;
    if (normalizedCandidate !== root && !normalizedCandidate.startsWith(rootWithSeparator)) {
      return yield* Effect.fail(
        new VirtualPathViolation("Resolved path escapes the virtual root."),
      );
    }

    let walked = root;
    for (const segment of segments) {
      walked = path.join(walked, segment);
      if (yield* isSymlink(walked)) {
        return yield* Effect.fail(
          new VirtualPathViolation(
            `Path component "${segment}" is a symlink; symlinks are not allowed under the virtual root.`,
          ),
        );
      }
    }

    return normalizedCandidate;
  });
}
