// Every MCP tool's JSON Schema is converted to Zod once per server
// connection, at startup and on every reconnect — so an agent wired to a few
// chatty MCP servers pays this whole set before its first prompt renders.
// It feeds the number `startup` measures from the outside.
import { bench, report } from "./harness";
import {
  convertMCPSchemaToZod,
  ensureObjectSchemaType,
  unwrapMCPJsonSchema,
} from "../packages/core/src/utils/mcp-schema-converter";

/** A typical tool: a flat object of scalars with descriptions and enums. */
function flatSchema(propertyCount: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let index = 0; index < propertyCount; index += 1) {
    properties[`field${String(index)}`] =
      index % 4 === 3
        ? {
            type: "string",
            enum: ["alpha", "beta", "gamma"],
            description: `choice ${String(index)}`,
          }
        : index % 4 === 2
          ? { type: "number", description: `count ${String(index)}` }
          : index % 4 === 1
            ? { type: "boolean", description: `flag ${String(index)}` }
            : { type: "string", description: `text ${String(index)}` };
    if (index % 3 === 0) required.push(`field${String(index)}`);
  }
  return { type: "object", properties, required };
}

/** The awkward one: nested objects and arrays, the shape that recurses. */
function nestedSchema(depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = { type: "string", description: "leaf" };
  for (let level = 0; level < depth; level += 1) {
    current = {
      type: "object",
      properties: {
        [`level${String(level)}`]: current,
        items: { type: "array", items: current },
        name: { type: "string" },
      },
      required: [`level${String(level)}`],
    };
  }
  return current;
}

/** Union branches, which `ensureObjectSchemaType` has to merge into one object. */
const unionSchema = {
  oneOf: [
    {
      type: "object",
      properties: { mode: { type: "string" }, path: { type: "string" } },
      required: ["mode"],
    },
    {
      type: "object",
      properties: { mode: { type: "string" }, query: { type: "string" } },
      required: ["mode"],
    },
    {
      type: "object",
      properties: { mode: { type: "string" }, limit: { type: "number" } },
      required: ["mode"],
    },
  ],
};

const small = flatSchema(8);
const wide = flatSchema(120);
const nested = nestedSchema(6);
// The SDK's envelope, which the converter unwraps before doing anything else.
const wrapped = { jsonSchema: { jsonSchema: wide } };

const results = [
  bench("convertMCPSchemaToZod 8 properties", () => {
    convertMCPSchemaToZod(small, "small_tool");
  }),
  bench("convertMCPSchemaToZod 120 properties", () => {
    convertMCPSchemaToZod(wide, "wide_tool");
  }),
  bench("convertMCPSchemaToZod nested depth 6", () => {
    convertMCPSchemaToZod(nested, "nested_tool");
  }),
  bench("convertMCPSchemaToZod oneOf branches", () => {
    convertMCPSchemaToZod(unionSchema, "union_tool");
  }),
  // One server's whole tool list: the unit a connection actually pays.
  bench(
    "convertMCPSchemaToZod 40-tool server",
    () => {
      for (let index = 0; index < 40; index += 1) {
        convertMCPSchemaToZod(index % 5 === 0 ? nested : small, `tool_${String(index)}`);
      }
    },
    { iterations: 60 },
  ),
  bench("unwrapMCPJsonSchema doubly wrapped", () => {
    unwrapMCPJsonSchema(wrapped);
  }),
  bench("ensureObjectSchemaType oneOf merge", () => {
    ensureObjectSchemaType(unionSchema);
  }),
];

report("mcp-schema", results);
