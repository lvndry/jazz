/** Verifies stable consent identity and invalidation on capability changes. */

import { expect, it } from "bun:test";
import type { PluginManifest } from "@/core/types/plugin";
import { computePluginConsentDigest } from "./consent";

const manifest: PluginManifest = {
  schemaVersion: 1,
  id: "com.example.router",
  name: "Router",
  version: "1.0.0",
  hostApi: 1,
  artifact: "plugin.js",
  sha256: "a".repeat(64),
  hooks: ["route.skills"],
  decisionProviders: [],
  tools: [],
  network: { destinations: ["b.example", "a.example"] },
  dataSent: ["skills", "request"],
  secrets: [],
};

it("canonicalizes order but invalidates consent when disclosure changes", () => {
  const reordered = {
    ...manifest,
    network: { destinations: [...manifest.network.destinations].reverse() },
    dataSent: [...manifest.dataSent].reverse(),
  };
  expect(computePluginConsentDigest(reordered)).toBe(computePluginConsentDigest(manifest));
  expect(
    computePluginConsentDigest({ ...manifest, dataSent: [...manifest.dataSent, "content"] }),
  ).not.toBe(computePluginConsentDigest(manifest));
});
