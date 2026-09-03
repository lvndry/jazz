/**
 * Implements `AgentService`: creating, validating, and mutating agent definitions on top of
 * a `StorageService`. Owns the validation rules (name/description/config shape), not just I/O.
 */

import { validateCustomToolDefinitionShape } from "@jazz/core/agent/tools/custom-tool-validation";
import { normalizeToolConfig } from "@jazz/core/agent/utils/tool-config";
import { AVAILABLE_PROVIDERS, isProviderName } from "@jazz/core/constants/models";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { StorageServiceTag, type StorageService } from "@jazz/core/interfaces/storage";
import { CommonSuggestions } from "@jazz/core/presentation/error-handler";
import { isReasoningEffort, REASONING_EFFORTS } from "@jazz/core/types/agent";
import { isWebSearchProviderName, WEB_SEARCH_PROVIDERS } from "@jazz/core/types/config";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "@jazz/core/types/errors";
import { type Agent, type AgentConfig, type CustomToolDefinition } from "@jazz/core/types/index";
import { COMPANION_ROLES, normalizeCompanionRole } from "@jazz/core/types/llm";
import { parseProviderModel } from "@jazz/core/utils/provider-model";
import { Effect, Layer } from "effect";
import shortuuid from "short-uuid";

export class AgentServiceImpl implements AgentService {
  constructor(private readonly storage: StorageService) {}

  createAgent(
    name: string,
    description: string | undefined,
    config: Partial<AgentConfig> = {},
  ): Effect.Effect<
    Agent,
    StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError
  > {
    return Effect.gen(
      function* (this: AgentServiceImpl) {
        yield* validateAgentName(name);
        if (description !== undefined) {
          yield* validateAgentDescription(description);
        }

        const id = shortuuid.generate();

        // Create default agent configuration
        const defaultConfig: AgentConfig = {
          persona: "default",
          llmProvider: "openai",
          llmModel: "gpt-4o",
        };

        const normalizedTools = normalizeToolConfig(config.tools, { agentId: id });

        const baseConfig: AgentConfig = {
          ...defaultConfig,
          ...config,
        };

        const agentConfig: AgentConfig =
          normalizedTools.length > 0 ? { ...baseConfig, tools: normalizedTools } : baseConfig;

        // Validate the complete agent configuration
        yield* this.validateAgentConfig(agentConfig);

        // Check if agent with same name already exists
        const existingAgents = yield* this.storage.listAgents();
        const nameExists = existingAgents.some((agent: Agent) => agent.name === name);

        if (nameExists) {
          return yield* Effect.fail(
            new AgentAlreadyExistsError({
              agentId: name,
              suggestion: CommonSuggestions.checkAgentExists(name),
            }),
          );
        }

        // Create the agent
        const now = new Date();
        const agent: Agent = {
          id,
          name,
          ...(description !== undefined && { description }),
          config: agentConfig,
          createdAt: now,
          updatedAt: now,
        };

        // Save the agent
        yield* this.storage.saveAgent(agent);

        return agent;
      }.bind(this),
    );
  }

  getAgent(id: string): Effect.Effect<Agent, StorageError | StorageNotFoundError> {
    return this.storage.getAgent(id);
  }

  listAgents(): Effect.Effect<readonly Agent[], StorageError> {
    return this.storage.listAgents();
  }

  updateAgent(
    id: string,
    updates: Partial<Agent>,
  ): Effect.Effect<
    Agent,
    | StorageError
    | StorageNotFoundError
    | AgentConfigurationError
    | AgentAlreadyExistsError
    | ValidationError
  > {
    return Effect.gen(
      function* (this: AgentServiceImpl) {
        const existingAgent = yield* this.storage.getAgent(id);

        if (updates.name && updates.name !== existingAgent.name) {
          yield* validateAgentName(updates.name);

          const agents = yield* this.storage.listAgents();
          const duplicateExists = agents.some(
            (agent) => agent.name === updates.name && agent.id !== existingAgent.id,
          );

          if (duplicateExists) {
            return yield* Effect.fail(
              new AgentAlreadyExistsError({
                agentId: updates.name,
                suggestion: CommonSuggestions.checkAgentExists(updates.name),
              }),
            );
          }
        }

        const mergedConfig: AgentConfig = {
          ...existingAgent.config,
          ...updates.config,
        };

        const normalizedTools = normalizeToolConfig(mergedConfig.tools, {
          agentId: existingAgent.id,
        });

        const { tools: _existingTools, ...configWithoutTools } = mergedConfig;
        void _existingTools;

        const baseConfig: AgentConfig = configWithoutTools;
        const updatedConfig: AgentConfig =
          normalizedTools.length > 0 ? { ...baseConfig, tools: normalizedTools } : baseConfig;

        const updatedAgent: Agent = {
          ...existingAgent,
          ...updates,
          id: existingAgent.id, // Ensure ID cannot be changed
          createdAt: existingAgent.createdAt, // Ensure createdAt cannot be changed
          updatedAt: new Date(),
          config: updatedConfig,
        };

        yield* this.validateAgentConfig(updatedAgent.config);

        yield* this.storage.saveAgent(updatedAgent);
        return updatedAgent;
      }.bind(this),
    );
  }

  deleteAgent(id: string): Effect.Effect<void, StorageError | StorageNotFoundError> {
    return this.storage.deleteAgent(id);
  }

  validateAgentConfig(config: AgentConfig): Effect.Effect<void, AgentConfigurationError> {
    return Effect.gen(function* (this: AgentServiceImpl) {
      const persona: unknown = config.persona;
      if (typeof persona !== "string" || persona.trim().length === 0) {
        return yield* Effect.fail(
          new AgentConfigurationError({
            agentId: "unknown",
            field: "config.persona",
            message: `Invalid persona ${JSON.stringify(persona)}`,
            suggestion:
              'Use a built-in persona ("default", "coder", "researcher") or the name of a persona file in ~/.jazz/personas/.',
          }),
        );
      }

      const llmProvider: unknown = config.llmProvider;
      if (typeof llmProvider !== "string" || !isProviderName(llmProvider)) {
        return yield* Effect.fail(
          new AgentConfigurationError({
            agentId: "unknown",
            field: "config.llmProvider",
            message: `Unknown LLM provider ${JSON.stringify(llmProvider)}`,
            suggestion: `Use one of: ${AVAILABLE_PROVIDERS.join(", ")}.`,
          }),
        );
      }

      const llmModel: unknown = config.llmModel;
      if (typeof llmModel !== "string" || llmModel.trim().length === 0) {
        return yield* Effect.fail(
          new AgentConfigurationError({
            agentId: "unknown",
            field: "config.llmModel",
            message: `Invalid LLM model ${JSON.stringify(llmModel)}`,
            suggestion: `Name a model the provider serves, e.g. "gpt-4o" for openai.`,
          }),
        );
      }

      if (config.llmApiKeys) {
        for (const [provider, apiKey] of Object.entries(config.llmApiKeys)) {
          if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: `config.llmApiKeys.${provider}`,
                message: "LLM API key overrides must be non-empty strings",
                suggestion: "Set a valid API key string or remove the provider override.",
              }),
            );
          }
        }
      }

      const summarizerModel: unknown = config.summarizerModel;
      if (summarizerModel !== undefined && summarizerModel !== null) {
        if (typeof summarizerModel !== "string" || parseProviderModel(summarizerModel) === null) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.summarizerModel",
              message: `Invalid summarizerModel ${JSON.stringify(summarizerModel)}`,
              suggestion:
                'Use "provider/model" with a known provider, e.g. "anthropic/claude-3-5-haiku-latest", or remove the field to use the agent\'s own model.',
            }),
          );
        }
      }

      const companions: unknown = config.companions;
      if (companions !== undefined && companions !== null) {
        if (typeof companions !== "object" || Array.isArray(companions)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.companions",
              message: "companions must be an object keyed by companion role",
              suggestion:
                'Use { "analyze:image": "provider/model", ... } with roles of the form <analyze|generate>:<image|audio|video>.',
            }),
          );
        }
        for (const [key, companion] of Object.entries(companions as Record<string, unknown>)) {
          if (normalizeCompanionRole(key) === undefined) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: `config.companions.${key}`,
                message: `Unknown companion role "${key}"`,
                suggestion: `Use one of: ${COMPANION_ROLES.join(", ")}.`,
              }),
            );
          }
          if (typeof companion !== "string" || parseProviderModel(companion) === null) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: `config.companions.${key}`,
                message: `Invalid ${key} companion ${JSON.stringify(companion)}`,
                suggestion:
                  'Use "provider/model", e.g. "anthropic/claude-sonnet-4-5", or remove the entry to let interactive sessions ask you to pick.',
              }),
            );
          }
        }
      }

      // Validate envAllowlist
      if (config.envAllowlist) {
        if (!Array.isArray(config.envAllowlist)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.envAllowlist",
              message: "envAllowlist must be provided as an array of env var names",
              suggestion: 'Supply an array of uppercase env var names, e.g. ["MY_TOKEN"].',
            }),
          );
        }

        // `Array.isArray` narrows to `any[]`, discarding the `readonly string[]`
        // element type, so re-assert it explicitly before using the value.
        const envAllowlist = config.envAllowlist as readonly string[];

        if (envAllowlist.length > 32) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.envAllowlist",
              message: `envAllowlist cannot contain more than 32 names (${envAllowlist.length} provided)`,
              suggestion: "Remove unused entries so at most 32 names remain.",
            }),
          );
        }

        for (const name of envAllowlist) {
          if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.envAllowlist",
                message: `Invalid env var name "${name}" in envAllowlist`,
                suggestion:
                  "Use uppercase letters, digits, and underscores only, starting with a letter, up to 64 characters (e.g. MY_TOKEN).",
              }),
            );
          }
        }
      }

      // Validate customTools
      if (config.customTools) {
        if (!Array.isArray(config.customTools)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.customTools",
              message: "customTools must be provided as an array of tool definitions",
              suggestion: "Supply an array of custom tool definitions.",
            }),
          );
        }

        // `Array.isArray` narrows to `any[]`, discarding the `readonly
        // CustomToolDefinition[]` element type, so re-assert it explicitly.
        const customTools = config.customTools as readonly CustomToolDefinition[];

        if (customTools.length > 16) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.customTools",
              message: `customTools cannot contain more than 16 entries (${customTools.length} provided)`,
              suggestion: "Remove unused entries so at most 16 custom tools remain.",
            }),
          );
        }

        const seenNames = new Set<string>();

        for (const customTool of customTools) {
          const { name } = customTool;

          const shapeIssue = validateCustomToolDefinitionShape(customTool);
          if (shapeIssue) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.customTools",
                message: shapeIssue.message,
                suggestion: shapeIssue.suggestion,
              }),
            );
          }

          if (seenNames.has(name)) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.customTools",
                message: `Duplicate custom tool name "${name}"`,
                suggestion: "Ensure every custom tool has a unique name.",
              }),
            );
          }
          seenNames.add(name);
        }
      }

      // Validate tools
      if (config.tools) {
        if (!Array.isArray(config.tools)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.tools",
              message: "Tools must be provided as an array of tool names",
              suggestion: "Select tools using the CLI or supply an array of tool identifiers.",
            }),
          );
        }

        for (const tool of config.tools) {
          if (typeof tool !== "string" || tool.trim().length === 0) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.tools",
                message: "Each tool entry must be a non-empty string",
              }),
            );
          }
        }
      }

      const reasoningEffort: unknown = config.reasoningEffort;
      if (reasoningEffort !== undefined && reasoningEffort !== null) {
        if (typeof reasoningEffort !== "string" || !isReasoningEffort(reasoningEffort)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.reasoningEffort",
              message: `Invalid reasoningEffort ${JSON.stringify(reasoningEffort)}`,
              suggestion: `Use one of: ${REASONING_EFFORTS.join(", ")}.`,
            }),
          );
        }
      }

      const temperature: unknown = config.temperature;
      if (temperature !== undefined && temperature !== null) {
        // The ceiling is the permissive superset across providers (OpenAI allows up to 2,
        // Anthropic only 1). Per-model limits are enforced at call time via
        // `supportsTemperature`, so validation only rejects what no provider would accept.
        if (
          typeof temperature !== "number" ||
          !Number.isFinite(temperature) ||
          temperature < 0 ||
          temperature > 2
        ) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.temperature",
              message: `Invalid temperature ${JSON.stringify(temperature)}`,
              suggestion:
                "Use a number between 0 and 2, or remove the field to use the provider default.",
            }),
          );
        }
      }

      for (const field of ["numCtx", "maxContextTokens"] as const) {
        const value: unknown = config[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: `config.${field}`,
              message: `Invalid ${field} ${JSON.stringify(value)}`,
              suggestion:
                "Use a positive whole number of tokens, or remove the field to use the default.",
            }),
          );
        }
      }

      const webSearchProvider: unknown = config.webSearchProvider;
      if (webSearchProvider !== undefined && webSearchProvider !== null) {
        if (typeof webSearchProvider !== "string" || !isWebSearchProviderName(webSearchProvider)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.webSearchProvider",
              message: `Unknown web search provider ${JSON.stringify(webSearchProvider)}`,
              suggestion: `Use one of: ${WEB_SEARCH_PROVIDERS.join(", ")}.`,
            }),
          );
        }
      }

      if (config.deniedTools !== undefined && config.deniedTools !== null) {
        if (!Array.isArray(config.deniedTools)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.deniedTools",
              message: "deniedTools must be provided as an array of tool names",
              suggestion: 'Supply an array of tool names, e.g. ["execute_command"].',
            }),
          );
        }

        for (const tool of config.deniedTools as readonly string[]) {
          if (typeof tool !== "string" || tool.trim().length === 0) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.deniedTools",
                message: "Each deniedTools entry must be a non-empty string",
                suggestion: "Remove blank entries so every denial names a tool.",
              }),
            );
          }
        }
      }

      if (config.memoryScopes !== undefined && config.memoryScopes !== null) {
        if (!Array.isArray(config.memoryScopes)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.memoryScopes",
              message: "memoryScopes must be provided as an array of scope names",
              suggestion: 'Supply an array of non-empty scope names, e.g. ["work"].',
            }),
          );
        }

        for (const scope of config.memoryScopes as readonly string[]) {
          if (typeof scope !== "string" || scope.trim().length === 0) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.memoryScopes",
                message: "Each memoryScopes entry must be a non-empty string",
                suggestion: "Remove blank entries so every scope has a name.",
              }),
            );
          }
        }
      }
    });
  }
}

function validateAgentName(name: string): Effect.Effect<void, ValidationError> {
  if (!name || name.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name cannot be empty",
        value: name,
        suggestion:
          "Provide a descriptive name for your agent, e.g., 'email-processor' or 'data-backup'",
      }),
    );
  }

  if (name.length > 100) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name cannot exceed 100 characters",
        value: name,
        suggestion: `Use a shorter name (${name.length}/100 characters). Consider using abbreviations or removing unnecessary words`,
      }),
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name can only contain letters, numbers, underscores, and hyphens",
        value: name,
        suggestion:
          "Use only letters (a-z, A-Z), numbers (0-9), underscores (_), and hyphens (-). Example: 'my-agent-1'",
      }),
    );
  }

  return Effect.void;
}

function validateAgentDescription(description: string): Effect.Effect<void, ValidationError> {
  if (!description || description.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Agent description cannot be empty",
        value: description,
        suggestion:
          "Provide a clear description of what this agent does, e.g., 'Processes incoming emails and categorizes them'",
      }),
    );
  }

  if (description.length > 500) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Agent description cannot exceed 500 characters",
        value: description,
        suggestion: `Use a shorter description (${description.length}/500 characters). Focus on the main purpose and key functionality`,
      }),
    );
  }

  return Effect.void;
}

export function createAgentServiceLayer(): Layer.Layer<AgentService, never, StorageService> {
  return Layer.effect(
    AgentServiceTag,
    Effect.map(StorageServiceTag, (storage) => new AgentServiceImpl(storage)),
  );
}
