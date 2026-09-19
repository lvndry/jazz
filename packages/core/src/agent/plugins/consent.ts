/** Builds the stable, core-owned disclosure identity used to invalidate plugin consent. */

import { createHash } from "node:crypto";
import type { PluginConsentDisclosure, PluginManifest } from "@/core/types/plugin";

const sortedUnique = <T extends string>(values: readonly T[]): readonly T[] =>
  [...new Set(values)].sort();

export function buildPluginConsentDisclosure(manifest: PluginManifest): PluginConsentDisclosure {
  return {
    pluginId: manifest.id,
    codeDigest: manifest.sha256,
    hooks: sortedUnique(manifest.hooks),
    policyHooks: sortedUnique(manifest.policyHooks),
    decisionProviders: sortedUnique(manifest.decisionProviders),
    destinations: sortedUnique(manifest.network.destinations),
    dataSent: sortedUnique(manifest.dataSent),
  };
}

export function canonicalizePluginConsent(disclosure: PluginConsentDisclosure): string {
  return JSON.stringify({
    schema: "jazz-plugin-consent-v1",
    pluginId: disclosure.pluginId,
    codeDigest: disclosure.codeDigest,
    hooks: sortedUnique(disclosure.hooks),
    policyHooks: sortedUnique(disclosure.policyHooks),
    decisionProviders: sortedUnique(disclosure.decisionProviders),
    destinations: sortedUnique(disclosure.destinations),
    dataSent: sortedUnique(disclosure.dataSent),
  });
}

export function computePluginConsentDigest(manifest: PluginManifest): string {
  return createHash("sha256")
    .update(canonicalizePluginConsent(buildPluginConsentDisclosure(manifest)))
    .digest("hex");
}
