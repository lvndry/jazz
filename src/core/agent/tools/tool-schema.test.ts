import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import { registerAllTools } from "./register-tools";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
            undescribed.push(
              `${name}: z.toJSONSchema failed (${error instanceof Error ? error.message : String(error)})`,
            );
            continue;
          }
          collectUndescribed(asSchema(json), name, undescribed);
        }

        return undescribed;
      }).pipe(Effect.provide(createToolRegistryLayer())),
    );

    expect(missing, missing.join("\n")).toEqual([]);
  });
});
