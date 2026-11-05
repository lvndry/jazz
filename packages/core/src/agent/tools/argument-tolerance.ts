import { z } from "zod";

/**
 * Why a model-supplied argument was set aside before validation.
 *
 * - `empty_optional`: an empty string, array or object where the schema declares an optional value.
 * - `null_optional`: null where the schema declares an optional (not nullable) value.
 * - `irrelevant_field`: a field that belongs to a different command of a multi-command tool.
 * - `unknown_field`: a field the tool does not declare, on a schema that would reject it.
 */
export type ArgumentRelaxationReason =
  "empty_optional" | "null_optional" | "irrelevant_field" | "unknown_field";

export interface ArgumentRelaxation {
  readonly field: string;
  readonly reason: ArgumentRelaxationReason;
}

export interface RelaxedArguments {
  readonly args: Record<string, unknown>;
  readonly relaxations: readonly ArgumentRelaxation[];
}

/**
 * Fields that carry authority or safety meaning. An empty or unexpected value for one of
 * these is reported to the model exactly as the schema reports it, because omitting it
 * would change what the call is allowed to do, spend, or send.
 */
const STRICT_FIELDS_EVERYWHERE: ReadonlySet<string> = new Set([
  "escalate",
  "force",
  "confirm",
  "overwrite",
  "snapshot",
  "expectedRevision",
  "revision",
  "password",
  "secret",
  "token",
  "apiKey",
  "workingDirectory",
  "maxCostUSD",
  "maxMinutes",
  "maxOutputTokens",
  "maxTokens",
  "maxCost",
  "budget",
  "approval",
  "approvalPolicy",
  "autoApprove",
  "riskLevel",
  "maxAttempts",
  "concurrencyCap",
  "host",
  "repo",
  "visibility",
  "destination",
  "recipient",
  "to",
  "channel",
]);

const ALL_FIELDS = "*";

/**
 * Strict fields that only matter on one tool: an output path that writes a file, or a
 * tool where an empty value is a real instruction (a cleared field).
 */
const STRICT_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  create_pdf: ["path"],
  update_work_state: [ALL_FIELDS],
  propose_goal: [ALL_FIELDS],
};

interface SchemaDefinition {
  readonly type: string;
  readonly shape?: Readonly<Record<string, z.core.$ZodType>>;
  readonly catchall?: z.core.$ZodType;
  readonly innerType?: z.core.$ZodType;
  readonly in?: z.core.$ZodType;
  readonly options?: readonly z.core.$ZodType[];
  readonly discriminator?: string;
  readonly values?: readonly unknown[];
}

function definitionOf(schema: z.core.$ZodType): SchemaDefinition {
  return schema._zod.def;
}

interface FieldTraits {
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly valueType: string;
}

function describeField(field: z.core.$ZodType): FieldTraits {
  let current = field;
  let optional = false;
  let nullable = false;
  for (;;) {
    const definition = definitionOf(current);
    if (definition.type === "optional" || definition.type === "default") {
      optional = true;
    } else if (definition.type === "nullable") {
      nullable = true;
    } else if (definition.type !== "readonly" && definition.type !== "prefault") {
      if (definition.type === "pipe" && definition.in !== undefined) {
        current = definition.in;
        continue;
      }
      return { optional, nullable, valueType: definition.type };
    }
    if (definition.innerType === undefined) {
      return { optional, nullable, valueType: definition.type };
    }
    current = definition.innerType;
  }
}

function isEmptyForType(value: unknown, valueType: string): boolean {
  if (value === "") {
    return valueType === "string" || valueType === "enum";
  }
  if (Array.isArray(value)) {
    return value.length === 0 && valueType === "array";
  }
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length === 0 && (valueType === "record" || valueType === "object");
  }
  return false;
}

interface ObjectView {
  readonly definition: SchemaDefinition;
  readonly siblingFields: ReadonlySet<string>;
}

function resolveObject(
  schema: z.core.$ZodType,
  args: Record<string, unknown>,
): ObjectView | undefined {
  const definition = definitionOf(schema);
  if (definition.type === "pipe" && definition.in !== undefined) {
    return resolveObject(definition.in, args);
  }
  if (definition.type === "object" && definition.shape !== undefined) {
    return { definition, siblingFields: new Set() };
  }
  if (
    definition.type === "union" &&
    definition.discriminator !== undefined &&
    definition.options !== undefined
  ) {
    const discriminator = definition.discriminator;
    const siblingFields = new Set<string>();
    let chosen: SchemaDefinition | undefined;
    for (const option of definition.options) {
      const optionDefinition = definitionOf(option);
      for (const key of Object.keys(optionDefinition.shape ?? {})) {
        siblingFields.add(key);
      }
      const literal = optionDefinition.shape?.[discriminator];
      const literalValues = literal === undefined ? undefined : definitionOf(literal).values;
      if (literalValues?.includes(args[discriminator]) === true) {
        chosen = optionDefinition;
      }
    }
    return chosen === undefined ? undefined : { definition: chosen, siblingFields };
  }
  return undefined;
}

function isStrictField(toolName: string, field: string): boolean {
  if (STRICT_FIELDS_EVERYWHERE.has(field)) {
    return true;
  }
  const toolStrict = STRICT_FIELDS_BY_TOOL[toolName];
  return (
    toolStrict !== undefined && (toolStrict.includes(ALL_FIELDS) || toolStrict.includes(field))
  );
}

/**
 * Set aside the arguments a model supplied that cannot change what the call does: an empty
 * value for an optional field counts as omitted, and a field the chosen command does not use
 * (or the tool does not declare, on a strict schema) is ignored. Only top-level fields are
 * considered. Declared types, required fields, nested values and every field in the strict
 * list are left for the schema to judge, so their errors are unchanged.
 *
 * The schema itself is not altered, so the JSON schema advertised to the model is the same.
 */
export function relaxToolArguments(
  toolName: string,
  schema: z.core.$ZodType,
  args: Record<string, unknown>,
): RelaxedArguments {
  const view = resolveObject(schema, args);
  if (view === undefined || view.definition.shape === undefined) {
    return { args, relaxations: [] };
  }
  const shape = view.definition.shape;
  const rejectsUnknown =
    view.definition.catchall !== undefined &&
    definitionOf(view.definition.catchall).type === "never";
  const relaxations: ArgumentRelaxation[] = [];
  const kept: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(args)) {
    const fieldSchema = shape[field];
    if (fieldSchema === undefined) {
      if (rejectsUnknown && !isStrictField(toolName, field)) {
        relaxations.push({
          field,
          reason: view.siblingFields.has(field) ? "irrelevant_field" : "unknown_field",
        });
        continue;
      }
      kept[field] = value;
      continue;
    }
    if (!isStrictField(toolName, field)) {
      const traits = describeField(fieldSchema);
      if (traits.optional && !traits.nullable && value === null) {
        relaxations.push({ field, reason: "null_optional" });
        continue;
      }
      if (traits.optional && isEmptyForType(value, traits.valueType)) {
        relaxations.push({ field, reason: "empty_optional" });
        continue;
      }
    }
    kept[field] = value;
  }

  return relaxations.length === 0 ? { args, relaxations } : { args: kept, relaxations };
}
