import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import { toError } from "@/core/utils/errors";
import { isRecord } from "@/core/utils/is-record";
import { registerAllTools } from "./register-tools";
import { ALL_CATEGORIES, BUILTIN_TOOL_CATEGORIES } from "./tool-categories";
import { createToolRegistryLayer } from "./tool-registry";

interface JsonSchemaNode {
  readonly type?: unknown;
  readonly const?: unknown;
  readonly description?: unknown;
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly items?: JsonSchemaNode | JsonSchemaNode[];
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly prefixItems?: readonly JsonSchemaNode[];
}

function asSchema(value: unknown): JsonSchemaNode | undefined {
  return isRecord(value) ? (value as JsonSchemaNode) : undefined;
}

function collectUndescribed(
  schema: JsonSchemaNode | undefined,
  path: string,
  missing: string[],
): void {
  if (!schema) return;

  if (schema.properties && isRecord(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      const childPath = `${path}.${key}`;
      if (property.const === undefined && !property.description) {
        missing.push(childPath);
      }
      collectUndescribed(property, childPath, missing);
    }
  }

  const unions = schema.oneOf ?? schema.anyOf;
  if (unions) {
    for (const [index, variant] of unions.entries()) {
      collectUndescribed(variant, `${path}[${index}]`, missing);
    }
  }

  if (schema.items) {
    if (Array.isArray(schema.items)) {
      for (const [index, item] of schema.items.entries()) {
        collectUndescribed(item, `${path}.items[${index}]`, missing);
      }
    } else {
      collectUndescribed(schema.items, `${path}.items`, missing);
    }
  }

  if (schema.prefixItems) {
    for (const [index, item] of schema.prefixItems.entries()) {
      collectUndescribed(item, `${path}.prefixItems[${index}]`, missing);
    }
  }
}

describe("tool JSON schemas advertised to the model", () => {
  it("gives every non-const property a description", async () => {
    const missing = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerAllTools();
        const registry = yield* ToolRegistryTag;
        const tools = yield* registry.listTools();
        const undescribed: string[] = [];

        for (const name of tools) {
          const tool = yield* registry.getTool(name);
          let json: unknown;
          try {
            json = z.toJSONSchema(tool.parameters);
          } catch (error) {
            undescribed.push(`${name}: z.toJSONSchema failed (${toError(error).message})`);
            continue;
          }
          collectUndescribed(asSchema(json), name, undescribed);
        }

        return undescribed;
      }).pipe(Effect.provide(createToolRegistryLayer())),
    );

    expect(missing, missing.join("\n")).toEqual([]);
  });

  /**
   * An agent is granted whole categories, and only the built-in ones unconditionally, so a
   * tool's text naming a tool from another opt-in category points the model at a tool it may
   * not have. Only underscored names are checked: short ones like `find` or `ls` collide with
   * ordinary words.
   */
  it("names only tools the same agent is guaranteed to have", async () => {
    const violations = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerAllTools();
        const registry = yield* ToolRegistryTag;
        const categoryByTool = new Map<string, string>();
        for (const category of ALL_CATEGORIES) {
          for (const toolName of yield* registry.getToolsInCategory(category.id)) {
            categoryByTool.set(toolName, category.id);
          }
        }
        const builtinCategoryIds = new Set(BUILTIN_TOOL_CATEGORIES.map((category) => category.id));
        const underscoredToolNames = [...categoryByTool.keys()].filter((name) =>
          name.includes("_"),
        );

        const found: string[] = [];
        for (const name of yield* registry.listTools()) {
          const tool = yield* registry.getTool(name);
          const advertisedText = `${tool.description} ${JSON.stringify(z.toJSONSchema(tool.parameters))}`;
          for (const mentioned of underscoredToolNames) {
            if (mentioned === name || !new RegExp(`\\b${mentioned}\\b`).test(advertisedText)) {
              continue;
            }
            const mentionedCategory = categoryByTool.get(mentioned);
            const guaranteed =
              mentionedCategory === categoryByTool.get(name) ||
              (mentionedCategory !== undefined && builtinCategoryIds.has(mentionedCategory));
            if (!guaranteed) {
              found.push(`${name} mentions ${mentioned} (${mentionedCategory ?? "uncategorized"})`);
            }
          }
        }
        return found;
      }).pipe(Effect.provide(createToolRegistryLayer())),
    );

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
