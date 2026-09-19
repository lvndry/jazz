/** Compile-time guard for the public SDK's structural compatibility with core. */

import { expect, it } from "bun:test";
import type * as Core from "@/core/types/plugin";
import type * as Sdk from "../packages/plugin-sdk/src/index";

type Assert<T extends true> = T;
type Equivalent<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false;

type PluginSdkAbiCompatibility = readonly [
  Assert<Equivalent<Core.JsonValue, Sdk.JsonValue>>,
  Assert<Equivalent<Core.SkillRouteInput, Sdk.SkillRouteInput>>,
  Assert<Equivalent<Core.SkillRouteOutcome, Sdk.SkillRouteOutcome>>,
  Assert<Equivalent<Core.DecisionQuestion, Sdk.DecisionQuestion>>,
  Assert<Equivalent<Core.DecisionRequest, Sdk.DecisionRequest>>,
  Assert<Equivalent<Core.DecisionAnswer, Sdk.DecisionAnswer>>,
  Assert<Equivalent<Core.DecisionBatchResult, Sdk.DecisionBatchResult>>,
  Assert<Equivalent<Core.DecisionProvider, Sdk.DecisionProvider>>,
  Assert<Equivalent<Core.PluginDecisionClient, Sdk.PluginDecisionClient>>,
  Assert<Equivalent<Core.PluginHostApi, Sdk.PluginHostApi>>,
  Assert<Sdk.JazzPluginModule extends Core.JazzPluginModule ? true : false>,
];

it("keeps the SDK boundary structurally aligned with core", () => {
  const checked: PluginSdkAbiCompatibility = [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ];
  expect(checked.every(Boolean)).toBe(true);
});
