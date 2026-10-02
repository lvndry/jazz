/** Strict boundary validation for manifests, decision batches, and advisory-hook results. */

import {
  MAX_DECISION_OPTIONS,
  MAX_DECISION_QUESTIONS,
  MAX_COMMAND_RISK_COMMAND_CHARS,
  MAX_PAGE_ELEMENTS,
  MAX_PAGE_LABEL_CHARS,
  MAX_PAGE_TITLE_CHARS,
  MAX_POLICY_ABSTENTION_REASON_CHARS,
  MAX_PLUGIN_IDENTIFIER_LENGTH,
  MAX_PLUGIN_STATE_BYTES,
  MAX_ROUTE_REQUEST_CHARS,
  PluginValidationError,
  isLifecycleEventId,
  type DecisionBatchResult,
  type DecisionRequest,
  type CommandRiskInput,
  type CommandRiskOutcome,
  type CompactToolCandidate,
  type CompactToolsDecision,
  type CompactToolsInput,
  type CompactToolsOutcome,
  type ClassifyPageInput,
  type ClassifyPageOutcome,
  type JsonValue,
  type PageElementSummary,
  type PageFlagId,
  type RouteSnapshotInput,
  type RouteSnapshotOutcome,
  type PluginManifest,
  type SkillRouteDistribution,
  type SkillRouteInput,
} from "@/core/types/plugin";
import { isRecord } from "@/core/utils/is-record";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EPSILON = 1e-6;
const ADVISORY_HOOK_IDS: ReadonlySet<string> = new Set([
  "route.skills",
  "compact.tools",
  "classify.page",
  "route.snapshot",
]);
const PAGE_FLAG_IDS: ReadonlySet<string> = new Set<PageFlagId>([
  "credential-entry",
  "payment",
  "captcha",
  "agent-directed-instructions",
]);

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
  if (manifest.hooks.some((hook) => !ADVISORY_HOOK_IDS.has(hook)))
    fail("manifest contains an unknown hook");
  if (new Set(manifest.policyHooks).size !== manifest.policyHooks.length)
    fail("manifest policy hooks must be unique");
  if (manifest.policyHooks.some((hook) => hook !== "classify.command-risk"))
    fail("manifest contains an unknown policy hook");
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
  if (new Set(manifest.lifecycleHooks).size !== manifest.lifecycleHooks.length) {
    fail("manifest lifecycleHooks must be unique");
  }
  if (manifest.lifecycleHooks.some((event) => !isLifecycleEventId(event))) {
    fail("manifest contains an unknown lifecycle event");
  }
  return manifest;
}

export function validateCommandRiskInput(input: CommandRiskInput): CommandRiskInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "command")
  ) {
    fail("command risk input must contain exactly command");
  }
  if (
    typeof input.command !== "string" ||
    input.command.length === 0 ||
    input.command.length > MAX_COMMAND_RISK_COMMAND_CHARS
  ) {
    fail(`command must contain 1-${MAX_COMMAND_RISK_COMMAND_CHARS} characters`);
  }
  return input;
}

export function validateCompactToolsInput(input: CompactToolsInput): CompactToolsInput {
  if (!isRecord(input)) {
    fail("compact tools input must be an object");
  }
  if (typeof input.goal !== "string" || input.goal.length > MAX_PLUGIN_STATE_BYTES) {
    fail("compact tools goal must be a bounded string");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_DECISION_QUESTIONS) {
    fail(`compact tools candidates must be an array of at most ${MAX_DECISION_QUESTIONS}`);
  }
  const seen = new Set<string>();
  for (const candidate of input.candidates as readonly CompactToolCandidate[]) {
    if (candidate === null || typeof candidate !== "object") {
      fail("compact tools candidate must be an object");
    }
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      fail("compact tools candidate id must be a non-empty string");
    }
    if (seen.has(candidate.id)) fail("compact tools candidate ids must be unique");
    seen.add(candidate.id);
    if (typeof candidate.tool !== "string") fail("compact tools candidate tool must be a string");
    if (candidate.input !== undefined && typeof candidate.input !== "string") {
      fail("compact tools candidate input must be a string");
    }
    if (typeof candidate.resultPreview !== "string") {
      fail("compact tools candidate resultPreview must be a string");
    }
    if (!Number.isInteger(candidate.resultChars) || candidate.resultChars < 0) {
      fail("compact tools candidate resultChars must be a non-negative integer");
    }
    if (typeof candidate.isError !== "boolean") {
      fail("compact tools candidate isError must be a boolean");
    }
  }
  return input;
}

export function validateCompactToolsOutcome(
  input: CompactToolsInput,
  outcome: CompactToolsOutcome,
): CompactToolsOutcome {
  if (outcome === null || typeof outcome !== "object")
    fail("compact tools outcome must be an object");
  if (outcome.status === "abstained") {
    if (
      typeof outcome.reason !== "string" ||
      outcome.reason.length === 0 ||
      outcome.reason.length > MAX_POLICY_ABSTENTION_REASON_CHARS
    ) {
      fail("compact tools abstention reason must be a bounded non-empty string");
    }
    return outcome;
  }
  if (outcome.status !== "answered" || !Array.isArray(outcome.decisions)) {
    fail("compact tools outcome must be answered with decisions, or abstained");
  }
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
  const decided = new Set<string>();
  for (const decision of outcome.decisions as readonly CompactToolsDecision[]) {
    if (decision === null || typeof decision !== "object") {
      fail("compact tools decision must be an object");
    }
    if (typeof decision.id !== "string" || !candidateIds.has(decision.id)) {
      fail("compact tools decision id must reference a candidate");
    }
    if (decided.has(decision.id)) fail("compact tools decision ids must be unique");
    decided.add(decision.id);
    if (
      decision.action !== "keep" &&
      decision.action !== "truncate" &&
      decision.action !== "drop"
    ) {
      fail("compact tools decision action must be keep, truncate, or drop");
    }
  }
  // A partial answer would let the reducer default every undecided candidate to keep, silently
  // suppressing the deterministic clearer. Require full coverage; otherwise abstain and fall back.
  if (decided.size !== candidateIds.size) {
    return {
      status: "abstained",
      reason: `compact tools response covered ${decided.size} of ${candidateIds.size} candidates`,
    };
  }
  return outcome;
}

export function validateCommandRiskOutcome(outcome: CommandRiskOutcome): CommandRiskOutcome {
  if (!isRecord(outcome)) fail("policy hook returned no outcome");
  if (outcome.status === "abstained") {
    if (
      Object.keys(outcome).length !== 2 ||
      !Object.hasOwn(outcome, "reason") ||
      typeof outcome.reason !== "string" ||
      outcome.reason.trim().length === 0 ||
      outcome.reason.length > MAX_POLICY_ABSTENTION_REASON_CHARS
    ) {
      fail(`abstention reason must contain 1-${MAX_POLICY_ABSTENTION_REASON_CHARS} characters`);
    }
    return outcome;
  }
  if (outcome.status !== "answered") fail("policy hook returned an unknown outcome status");
  if (Object.keys(outcome).length !== 2 || !Object.hasOwn(outcome, "distribution")) {
    fail("answered policy outcome must contain exactly status and distribution");
  }
  const distribution = outcome.distribution;
  if (distribution === null || typeof distribution !== "object")
    fail("command risk distribution must be an object");
  const keys = Object.keys(distribution).sort();
  const expected = ["highRiskProbability", "lowRiskProbability", "readOnlyProbability"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    fail("command risk distribution must contain exactly three probabilities");
  assertProbability(distribution.readOnlyProbability, "readOnlyProbability");
  assertProbability(distribution.lowRiskProbability, "lowRiskProbability");
  assertProbability(distribution.highRiskProbability, "highRiskProbability");
  const sum =
    distribution.readOnlyProbability +
    distribution.lowRiskProbability +
    distribution.highRiskProbability;
  if (Math.abs(sum - 1) > EPSILON) fail("command risk probabilities must sum to 1");
  return outcome;
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

function readRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(`${what} must be an array`);
  }
  return value as readonly unknown[];
}

function readBoundedString(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    fail(`${what} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function readProbability(value: unknown, what: string): number {
  if (typeof value !== "number") {
    fail(`${what} must be a number`);
  }
  assertProbability(value, what);
  return value;
}

function readAbstentionReason(record: Readonly<Record<string, unknown>>, what: string): string {
  const reason = record["reason"];
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > MAX_POLICY_ABSTENTION_REASON_CHARS
  ) {
    fail(`${what} abstention reason must be a bounded non-empty string`);
  }
  return reason;
}

function validatePageElements(elements: readonly PageElementSummary[]): void {
  const listed = readArray(elements, "page elements");
  if (listed.length > MAX_PAGE_ELEMENTS) {
    fail(`page elements must be at most ${MAX_PAGE_ELEMENTS}`);
  }
  const refs = new Set<string>();
  for (const item of listed) {
    const element = readRecord(item, "page element");
    const ref = element["ref"];
    if (typeof ref !== "string" || ref.length === 0 || refs.has(ref)) {
      fail("page element refs must be unique non-empty strings");
    }
    refs.add(ref);
    readBoundedString(element["role"], "page element role", MAX_PAGE_LABEL_CHARS);
    readBoundedString(element["label"], "page element label", MAX_PAGE_LABEL_CHARS);
  }
}

export function validateClassifyPageInput(input: ClassifyPageInput): ClassifyPageInput {
  const record = readRecord(input, "classify page input");
  if (typeof record["origin"] !== "string" || record["origin"].length === 0) {
    fail("classify page origin must be a non-empty string");
  }
  readBoundedString(record["title"], "classify page title", MAX_PAGE_TITLE_CHARS);
  validatePageElements(input.elements);
  const signals = readRecord(record["signals"], "classify page signals");
  if (
    typeof signals["passwordField"] !== "boolean" ||
    typeof signals["paymentField"] !== "boolean"
  ) {
    fail("classify page signals must be booleans");
  }
  return input;
}

/**
 * The only thing a page classification can express is "this page may be flagged, with this
 * probability". The result is rebuilt from the two known fields, so anything else a plugin
 * attaches (a risk level, an approval decision, a taint instruction) never leaves this function.
 */
export function validateClassifyPageOutcome(outcome: ClassifyPageOutcome): ClassifyPageOutcome {
  const record = readRecord(outcome, "classify page outcome");
  if (record["status"] === "abstained") {
    return { status: "abstained", reason: readAbstentionReason(record, "classify page") };
  }
  if (record["status"] !== "answered") {
    fail("classify page outcome must be answered with flags, or abstained");
  }
  const seen = new Set<string>();
  const flags = readArray(record["flags"], "classify page flags").map((item) => {
    const entry = readRecord(item, "classify page flag");
    const flag = entry["flag"];
    if (typeof flag !== "string" || !PAGE_FLAG_IDS.has(flag)) {
      fail("classify page flag must be a known flag");
    }
    if (seen.has(flag)) {
      fail("classify page flags must be unique");
    }
    seen.add(flag);
    return { flag: flag as PageFlagId, probability: readProbability(entry["probability"], flag) };
  });
  return { status: "answered", flags };
}

export function validateRouteSnapshotInput(input: RouteSnapshotInput): RouteSnapshotInput {
  const record = readRecord(input, "route snapshot input");
  readBoundedString(record["requestText"], "route snapshot request text", MAX_ROUTE_REQUEST_CHARS);
  if (typeof record["origin"] !== "string" || record["origin"].length === 0) {
    fail("route snapshot origin must be a non-empty string");
  }
  validatePageElements(input.elements);
  return input;
}

export function validateRouteSnapshotOutcome(
  input: RouteSnapshotInput,
  outcome: RouteSnapshotOutcome,
): RouteSnapshotOutcome {
  const record = readRecord(outcome, "route snapshot outcome");
  if (record["status"] === "abstained") {
    return { status: "abstained", reason: readAbstentionReason(record, "route snapshot") };
  }
  if (record["status"] !== "answered") {
    fail("route snapshot outcome must be answered with a distribution, or abstained");
  }
  const distribution = readRecord(record["distribution"], "snapshot distribution");
  const allowed = new Set(input.elements.map(({ ref }) => ref));
  const listed = readArray(distribution["elements"], "snapshot distribution elements");
  if (listed.length !== allowed.size) {
    fail("snapshot distribution must include every element exactly once");
  }
  const noElementProbability = readProbability(
    distribution["noElementProbability"],
    "noElementProbability",
  );
  let sum = noElementProbability;
  const seen = new Set<string>();
  const elements = listed.map((item) => {
    const entry = readRecord(item, "snapshot distribution element");
    const ref = entry["ref"];
    if (typeof ref !== "string" || !allowed.has(ref) || seen.has(ref)) {
      fail("snapshot distribution contains an unknown or duplicate element");
    }
    seen.add(ref);
    const probability = readProbability(entry["probability"], `element ${ref}`);
    sum += probability;
    return { ref, probability };
  });
  if (Math.abs(sum - 1) > EPSILON) {
    fail("snapshot probabilities including no-element must sum to 1");
  }
  return { status: "answered", distribution: { elements, noElementProbability } };
}
