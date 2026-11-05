/**
 * Layer provenance for the merged configuration: which layer set each key, which lower layers it
 * replaced, and which values the loader refused to apply.
 *
 * Tracing reads the same layers `mergeConfigLayers` merges and never takes part in the merge, so
 * the resolved values cannot differ from the ones the runtime uses. A leaf is any value that is
 * not a plain object: lists and single values replace whole, exactly as they do in the merge.
 */

import { isRecord } from "@jazz/core/utils/is-record";

export type ConfigSource =
  | { readonly kind: "default" }
  | { readonly kind: "global"; readonly path: string }
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "flag"; readonly flag: string }
  | { readonly kind: "env"; readonly variable: string };

export interface ProvenanceLayer {
  readonly source: ConfigSource;
  readonly document: Readonly<Record<string, unknown>>;
}

export interface OverriddenValue {
  readonly value: unknown;
  readonly source: ConfigSource;
}

export interface TracedSetting {
  readonly path: string;
  readonly value: unknown;
  readonly source: ConfigSource;
  /** Lower-precedence values this one replaced, lowest precedence first. */
  readonly overridden: readonly OverriddenValue[];
}

/** A value a layer set that the loader did not apply, and why. */
export interface DroppedSetting {
  readonly path: string;
  readonly value: unknown;
  readonly source: ConfigSource;
  readonly reason: string;
}

interface Leaf {
  readonly segments: readonly string[];
  readonly value: unknown;
}

interface LiveSetting {
  readonly segments: readonly string[];
  readonly value: unknown;
  readonly source: ConfigSource;
  readonly overridden: readonly OverriddenValue[];
}

function collectLeaves(
  document: Readonly<Record<string, unknown>>,
  prefix: readonly string[],
  into: Leaf[],
): void {
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined) {
      continue;
    }
    const segments = [...prefix, key];
    if (isRecord(value)) {
      collectLeaves(value, segments, into);
    } else {
      into.push({ segments, value });
    }
  }
}

function isPrefixOf(shorter: readonly string[], longer: readonly string[]): boolean {
  return (
    shorter.length <= longer.length && shorter.every((segment, index) => longer[index] === segment)
  );
}

function overlaps(first: readonly string[], second: readonly string[]): boolean {
  return isPrefixOf(first, second) || isPrefixOf(second, first);
}

/** Dotted display path: the shape `jazz config get` and the secret registry use. */
export function displayPath(segments: readonly string[]): string {
  return segments.join(".");
}

/** Code-unit order, so the listing does not change with the user's locale. */
export function compareText(first: string, second: string): number {
  if (first < second) {
    return -1;
  }
  return first > second ? 1 : 0;
}

/**
 * The effective leaves of `layers`, lowest precedence first. A later leaf replaces an earlier one
 * at the same path, and also one nested under or above it: a project `peers` list replaces the
 * global list whole, and a section set to one value replaces the keys beneath it.
 */
export function traceLayers(layers: readonly ProvenanceLayer[]): TracedSetting[] {
  let live: LiveSetting[] = [];
  for (const layer of layers) {
    const leaves: Leaf[] = [];
    collectLeaves(layer.document, [], leaves);
    for (const leaf of leaves) {
      const replaced = live.filter((entry) => overlaps(entry.segments, leaf.segments));
      live = live.filter((entry) => !overlaps(entry.segments, leaf.segments));
      live.push({
        segments: leaf.segments,
        value: leaf.value,
        source: layer.source,
        overridden: replaced.flatMap((entry) => [
          ...entry.overridden,
          { value: entry.value, source: entry.source },
        ]),
      });
    }
  }
  return live
    .map((entry) => ({
      path: displayPath(entry.segments),
      value: entry.value,
      source: entry.source,
      overridden: entry.overridden,
    }))
    .sort((first, second) => compareText(first.path, second.path));
}
