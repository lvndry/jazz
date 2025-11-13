import { type ChatMessage, type ToolDefinition } from "../../../services/llm/types";
import { type ToolRoutingMetadata } from "./tool-registry";

export interface ToolSelectionConfig {
  readonly mode?: "auto" | "all" | "manual";
  readonly maxTools?: number;
  readonly minScore?: number;
  readonly manualTools?: readonly string[];
  readonly forceTools?: readonly string[];
  readonly allowFallback?: boolean;
}

export interface ToolSelectionInput {
  readonly userInput: string;
  readonly conversationHistory?: readonly ChatMessage[];
  readonly candidateToolNames: readonly string[];
  readonly metadataByName: ReadonlyMap<string, ToolRoutingMetadata>;
  readonly definitionsByName: ReadonlyMap<string, ToolDefinition>;
  readonly config?: ToolSelectionConfig;
}

export interface ToolScore {
  readonly toolName: string;
  readonly score: number;
  readonly matchedKeywords: readonly string[];
  readonly matchedTags: readonly string[];
}

export interface ToolSelectionResult {
  readonly mode: "auto" | "all" | "manual";
  readonly selected: readonly string[];
  readonly ranking: readonly ToolScore[];
  readonly excluded: readonly ToolScore[];
}

const DEFAULT_SELECTION_CONFIG: Required<
  Pick<ToolSelectionConfig, "mode" | "maxTools" | "minScore" | "allowFallback">
> = {
  mode: "auto",
  maxTools: 3,
  minScore: 0.25,
  allowFallback: true,
};

const TOKEN_REGEX = /[^a-z0-9]+/gi;

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["cd", "change", "switch", "enter", "goto", "navigate", "nav"],
  ["list", "show", "display", "ls", "view"],
  ["folder", "directory", "dir", "path"],
  ["file", "document", "doc"],
  ["read", "open", "view", "show"],
  ["write", "save", "update", "create", "edit"],
  ["search", "find", "locate", "lookup", "discover"],
  ["delete", "remove", "rm", "erase"],
  ["run", "execute", "command"],
  ["git", "repository", "repo"],
];

const SYNONYM_LOOKUP: ReadonlyMap<string, string> = buildSynonymLookup(SYNONYM_GROUPS);
const EMPTY_ROUTING_METADATA: ToolRoutingMetadata = { tags: [], keywords: [] };

export function selectToolsForTurn(input: ToolSelectionInput): ToolSelectionResult {
  const candidateNames = uniqueStrings(input.candidateToolNames);
  const config = mergeConfig(input.config);
  const mode = config.mode;

  if (candidateNames.length === 0) {
    return {
      mode,
      selected: [],
      ranking: [],
      excluded: [],
    };
  }

  if (mode === "manual") {
    const manual = uniqueStrings(config.manualTools ?? []).filter((name) =>
      candidateNames.includes(name),
    );
    const forced = uniqueStrings(config.forceTools ?? []).filter((name) =>
      candidateNames.includes(name),
    );
    const selected = uniqueStrings([...forced, ...manual]);
    const ranking = rankTools(input, candidateNames);
    const selectedSet = new Set(selected);
    const excluded = ranking.filter((item) => !selectedSet.has(item.toolName));

    return {
      mode,
      selected,
      ranking,
      excluded,
    };
  }

  if (mode === "all") {
    const ranking = rankTools(input, candidateNames);
    return {
      mode,
      selected: candidateNames,
      ranking,
      excluded: [],
    };
  }

  // Auto mode
  const ranking = rankTools(input, candidateNames);
  const forced = uniqueStrings(config.forceTools ?? []).filter((name) =>
    candidateNames.includes(name),
  );

  const autoSelected: string[] = [];
  for (const item of ranking) {
    if (item.score >= config.minScore) {
      autoSelected.push(item.toolName);
    }
    if (autoSelected.length >= config.maxTools) {
      break;
    }
  }

  let selected = uniqueStrings([...forced, ...autoSelected]).slice(0, config.maxTools);

  if (selected.length === 0 && config.allowFallback) {
    const topCandidate = ranking[0];
    if (topCandidate) {
      selected = [topCandidate.toolName];
    }
  }

  const selectedSet = new Set(selected);
  const excluded = ranking.filter((item) => !selectedSet.has(item.toolName));

  return {
    mode,
    selected,
    ranking,
    excluded,
  };
}

function rankTools(input: ToolSelectionInput, candidateNames: readonly string[]): ToolScore[] {
  const queryText = selectQueryText(input.userInput, input.conversationHistory);
  const queryTokens = tokenize(queryText);
  const expandedQueryTokens = expandTokens(queryTokens);
  const queryTokenSet = new Set(expandedQueryTokens);

  const scores: ToolScore[] = [];

  for (const toolName of candidateNames) {
    const definition = input.definitionsByName.get(toolName);
    if (!definition) continue;

    const metadata = input.metadataByName.get(toolName) ?? EMPTY_ROUTING_METADATA;

    const nameTokens = splitIdentifier(toolName);
    const keywordTokens = metadata.keywords
      ? metadata.keywords.flatMap((keyword) => tokenize(keyword))
      : [];
    const tagTokens = metadata.tags ? metadata.tags.flatMap((tag) => tokenize(tag)) : [];
    const descriptionTokens = tokenize(definition.function.description ?? "");

    const toolTokens = uniqueStrings([
      ...nameTokens,
      ...keywordTokens,
      ...tagTokens,
      ...descriptionTokens,
    ]).map(normalizeToken);

    const matches = toolTokens.filter((token) => queryTokenSet.has(token));
    const matchedKeywords = (metadata.keywords ?? []).filter((keyword) => {
      const keywordTokens = tokenize(keyword).map(normalizeToken);
      return keywordTokens.some((token) => queryTokenSet.has(token));
    });
    const matchedTags = (metadata.tags ?? []).filter((tag) => {
      const tagTokens = tokenize(tag).map(normalizeToken);
      return tagTokens.some((token) => queryTokenSet.has(token));
    });

    const keywordScore = matches.length / Math.max(3, Math.min(toolTokens.length, 12));
    const similarity = cosineSimilarity(expandedQueryTokens, toolTokens);
    const nameBonus = nameTokens.map(normalizeToken).some((token) => queryTokenSet.has(token))
      ? 0.18
      : 0;
    const tagBonus = Math.min(0.12, matchedTags.length * 0.06);
    const priorityBonus = metadata.priority ? Math.min(0.1, metadata.priority / 10) : 0;

    const rawScore = keywordScore * 0.5 + similarity * 0.3 + nameBonus + tagBonus + priorityBonus;
    const score = clamp(rawScore, 0, 1);

    scores.push({
      toolName,
      score,
      matchedKeywords,
      matchedTags,
    });
  }

  return scores.sort((a, b) => b.score - a.score);
}

function mergeConfig(
  config?: ToolSelectionConfig,
): Required<Pick<ToolSelectionConfig, "mode" | "maxTools" | "minScore" | "allowFallback">> &
  ToolSelectionConfig {
  if (!config) {
    return { ...DEFAULT_SELECTION_CONFIG };
  }
  return {
    ...DEFAULT_SELECTION_CONFIG,
    ...config,
    mode: config.mode ?? DEFAULT_SELECTION_CONFIG.mode,
    maxTools: config.maxTools ?? DEFAULT_SELECTION_CONFIG.maxTools,
    minScore: config.minScore ?? DEFAULT_SELECTION_CONFIG.minScore,
    allowFallback: config.allowFallback ?? DEFAULT_SELECTION_CONFIG.allowFallback,
  };
}

function selectQueryText(userInput: string, history?: readonly ChatMessage[]): string {
  const trimmed = userInput.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  if (!history || history.length === 0) {
    return "";
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message && message.role === "user" && message.content.trim().length > 0) {
      return message.content.trim();
    }
  }
  return "";
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(TOKEN_REGEX)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function expandTokens(tokens: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeToken(token);
    expanded.push(normalized);
  }
  return uniqueStrings(expanded);
}

function splitIdentifier(identifier: string): string[] {
  if (!identifier) return [];
  const withSpaces = identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return tokenize(`${identifier} ${withSpaces}`);
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value !== "")));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildSynonymLookup(groups: readonly (readonly string[])[]): ReadonlyMap<string, string> {
  const entries: [string, string][] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    const canonical = group[0];
    if (!canonical) continue;
    for (const token of group) {
      entries.push([token, canonical]);
    }
  }
  return new Map(entries);
}

function normalizeToken(token: string): string {
  const lower = token.toLowerCase();
  return SYNONYM_LOOKUP.get(lower) ?? lower;
}

function cosineSimilarity(tokensA: readonly string[], tokensB: readonly string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }
  const freqA = buildFrequency(tokensA.map(normalizeToken));
  const freqB = buildFrequency(tokensB.map(normalizeToken));

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  freqA.forEach((value, key) => {
    magnitudeA += value * value;
    const valueB = freqB.get(key);
    if (valueB !== undefined) {
      dot += value * valueB;
    }
  });

  freqB.forEach((value) => {
    magnitudeB += value * value;
  });

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

function buildFrequency(tokens: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}
