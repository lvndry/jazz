/** Strict boundary validation for manifests, decision batches, and advisory-hook results. */

import {
  MAX_DECISION_OPTIONS,
  MAX_DECISION_QUESTIONS,
  MAX_PLUGIN_IDENTIFIER_LENGTH,
  MAX_PLUGIN_STATE_BYTES,
  PluginValidationError,
  type DecisionBatchResult,
  type DecisionRequest,
  type JsonValue,
  type PluginManifest,
  type SkillRouteDistribution,
  type SkillRouteInput,
} from "@/core/types/plugin";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EPSILON = 1e-6;

function fail(message: string): never {
  throw new PluginValidationError({ message });
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PLUGIN_IDENTIFIER_LENGTH && IDENTIFIER.test(value);
}

function assertProbability(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) fail(`${field} must be between 0 and 1`);
}

function assertJsonValue(value: JsonValue, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("decision state contains a non-finite number");
    return;
  }
  if (seen.has(value)) fail("decision state must not contain cycles");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value as readonly JsonValue[]) assertJsonValue(child, seen);
  } else {
    const object = value as Readonly<Record<string, JsonValue>>;
    for (const key of Object.keys(object)) assertJsonValue(object[key]!, seen);
  }
  seen.delete(value);
}

export function validatePluginManifest(manifest: PluginManifest): PluginManifest {
  if (!validIdentifier(manifest.id)) fail("invalid plugin id");
  if (manifest.hostApi !== 1) fail("unsupported plugin API version");
  if (!SHA256.test(manifest.sha256)) fail("sha256 must be a lowercase SHA-256 hex digest");
  if (new Set(manifest.hooks).size !== manifest.hooks.length) fail("manifest hooks must be unique");
  if (manifest.hooks.some((hook) => hook !== "route.skills"))
    fail("manifest contains an unknown hook");
  const secretNames = manifest.secrets.map(({ name }) => name);
  if (
    secretNames.some((name) => !validIdentifier(name)) ||
    new Set(secretNames).size !== secretNames.length
  ) {
    fail("manifest secret names must be valid and unique");
  }
  const toolNames = manifest.tools.map(({ name }) => name);
  if (
    toolNames.some((name) => !validIdentifier(name)) ||
    new Set(toolNames).size !== toolNames.length
  ) {
    fail("manifest tool names must be valid and unique");
  }
  for (const tool of manifest.tools) {
    if (tool.description.length === 0) fail(`tool ${tool.name} must have a description`);
    if (
      tool.riskLevel !== "read-only" &&
      tool.riskLevel !== "low-risk" &&
      tool.riskLevel !== "high-risk"
    ) {
      fail(`tool ${tool.name} has an invalid risk level`);
    }
    if (typeof tool.egress !== "boolean") fail(`tool ${tool.name} must declare egress`);
    assertJsonValue(tool.parameters);
  }
  const commandNames = manifest.commands.map(({ name }) => name);
  if (
    commandNames.some((name) => !validIdentifier(name)) ||
    new Set(commandNames).size !== commandNames.length
  ) {
    fail("manifest command names must be valid and unique");
  }
  for (const command of manifest.commands) {
    if (command.description.length === 0) fail(`command ${command.name} must have a description`);
  }
  const personaNames = manifest.personas.map(({ name }) => name);
  if (
    personaNames.some((name) => !validIdentifier(name)) ||
    new Set(personaNames).size !== personaNames.length
  ) {
    fail("manifest persona names must be valid and unique");
  }
  for (const persona of manifest.personas) {
    if (persona.description.length === 0) fail(`persona ${persona.name} must have a description`);
    if (persona.systemPrompt.length === 0) fail(`persona ${persona.name} must have a systemPrompt`);
  }
  const skillNames = manifest.skills.map(({ name }) => name);
  if (
    skillNames.some((name) => !validIdentifier(name)) ||
    new Set(skillNames).size !== skillNames.length
  ) {
    fail("manifest skill names must be valid and unique");
  }
  for (const skill of manifest.skills) {
    if (skill.description.length === 0) fail(`skill ${skill.name} must have a description`);
    if (skill.content.length === 0) fail(`skill ${skill.name} must have content`);
  }
  return manifest;
}

export function validateDecisionRequest(request: DecisionRequest): DecisionRequest {
  assertJsonValue(request.state);
  let encoded: string;
  try {
    encoded = JSON.stringify(request.state);
  } catch {
    fail("decision state must be JSON serializable");
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_PLUGIN_STATE_BYTES)
    fail("decision state is too large");
  if (request.questions.length === 0 || request.questions.length > MAX_DECISION_QUESTIONS) {
    fail("decision question count is out of range");
  }
  const ids = new Set<string>();
  for (const { id, question } of request.questions) {
    if (!validIdentifier(id) || ids.has(id)) fail("decision question ids must be valid and unique");
    ids.add(id);
    if (question.instructions.trim().length === 0) fail(`question ${id} has empty instructions`);
    if (question.kind === "choice") {
      if (question.options.length < 2 || question.options.length > MAX_DECISION_OPTIONS)
        fail(`question ${id} has invalid options`);
      const values = question.options.map(({ value }) => value);
      if (values.some((value) => value.length === 0) || new Set(values).size !== values.length)
        fail(`question ${id} options must be non-empty and unique`);
    }
  }
  return request;
}

export function validateDecisionResult(
  request: DecisionRequest,
  result: DecisionBatchResult,
): DecisionBatchResult {
  if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0)
    fail("provider latency must be non-negative");
  if (result.costUSD !== undefined && (!Number.isFinite(result.costUSD) || result.costUSD < 0))
    fail("provider cost must be non-negative");
  if (
    result.usage &&
    (!Number.isInteger(result.usage.inputTokens) ||
      result.usage.inputTokens < 0 ||
      !Number.isInteger(result.usage.outputTokens) ||
      result.usage.outputTokens < 0)
  )
    fail("provider usage must contain non-negative integer token counts");
  const expected = new Map(request.questions.map((entry) => [entry.id, entry.question] as const));
  if (result.answers.length !== expected.size)
    fail("provider must return exactly one answer per question");
  const seen = new Set<string>();
  for (const { id, outcome } of result.answers) {
    const question = expected.get(id);
    if (!question || seen.has(id)) fail("provider returned unknown or duplicate question id");
    seen.add(id);
    if (outcome.status === "abstained") continue;
    const answer = outcome.answer;
    if (answer.kind !== question.kind) fail(`provider returned wrong answer kind for ${id}`);
    if (answer.kind === "probability") assertProbability(answer.probability, `answer ${id}`);
    if (answer.kind === "choice" && question.kind === "choice") {
      const options = new Set(question.options.map(({ value }) => value));
      if (!options.has(answer.choice) || answer.probabilities.length !== options.size)
        fail(`answer ${id} does not cover the declared options`);
      let sum = 0;
      const returned = new Set<string>();
      for (const item of answer.probabilities) {
        if (!options.has(item.value) || returned.has(item.value))
          fail(`answer ${id} contains an unknown or duplicate option`);
        returned.add(item.value);
        assertProbability(item.probability, `answer ${id}`);
        sum += item.probability;
      }
      if (Math.abs(sum - 1) > EPSILON) fail(`answer ${id} probabilities must sum to 1`);
    }
    if (
      answer.kind === "score" &&
      question.kind === "score" &&
      (!Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.levels.length - 1)
    )
      fail(`answer ${id} score is out of range`);
  }
  return result;
}

export function validateSkillRouteInput(input: SkillRouteInput): SkillRouteInput {
  const names = input.skills.map(({ name }) => name);
  if (new Set(names).size !== names.length || names.some((name) => name.length === 0))
    fail("skill names must be non-empty and unique");
  return input;
}

export function validateSkillRouteDistribution(
  input: SkillRouteInput,
  distribution: SkillRouteDistribution,
): SkillRouteDistribution {
  const allowed = new Set(input.skills.map(({ name }) => name));
  if (distribution.skills.length !== allowed.size)
    fail("skill distribution must include every candidate exactly once");
  let sum = distribution.noSkillProbability;
  assertProbability(distribution.noSkillProbability, "noSkillProbability");
  const seen = new Set<string>();
  for (const item of distribution.skills) {
    if (!allowed.has(item.name) || seen.has(item.name))
      fail("skill distribution contains an unknown or duplicate skill");
    seen.add(item.name);
    assertProbability(item.probability, `skill ${item.name}`);
    sum += item.probability;
  }
  if (Math.abs(sum - 1) > EPSILON) fail("skill probabilities including no-skill must sum to 1");
  return distribution;
}
