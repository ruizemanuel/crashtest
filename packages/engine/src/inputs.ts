// Derives a tool's test input from its JSON Schema, plus the two field lists the engine needs later:
// free-text fields (rewritten on replays, so they must never feed an idempotency key) and identity fields
// (the business identity of a call, used to build idempotency keys). Pure and deterministic: no random
// values, so the values that show up in reports are readable and stable.
import type { JsonSchema } from "./types.ts";

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const FREE_TEXT_NAME = /^(text|body|message|content|subject|description|note|notes|comment|reason|summary|title|html|markdown)$/i;
const FREE_TEXT_SUFFIX = /(Text|Message|Body)$/;
const PERSON_NAME = /^(to|recipient|user|customer)$/i;
const ID_NAME = /(^id|Id|_id)$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The declared `type`; for a list such as `["null", "string"]`, the first entry that is not "null". */
function declaredType(schema: Record<string, unknown>): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.find((entry): entry is string => typeof entry === "string" && entry !== "null");
  return undefined;
}

function inferredType(schema: Record<string, unknown>): string {
  const declared = declaredType(schema);
  if (declared !== undefined) return declared;
  if (isObject(schema.properties)) return "object";
  if ("items" in schema) return "array";
  return "string";
}

function isNullBranch(branch: unknown): boolean {
  return isObject(branch) && (branch.type === "null" || branch.const === null);
}

function firstNonNullBranch(branches: unknown): { branch: unknown } | undefined {
  if (!Array.isArray(branches)) return undefined;
  const branch = branches.find((candidate) => !isNullBranch(candidate));
  return branch === undefined ? undefined : { branch };
}

function sampleString(schema: Record<string, unknown>, name: string): string {
  const format = schema.format;
  if (format === "email") return "alice@example.test";
  if (format === "uri") return "https://example.test/r/1";
  if (format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (format === "date") return "2026-01-01";
  if (/email/i.test(name)) return "alice@example.test";
  if (/url|uri|link/i.test(name)) return "https://example.test/r/1";
  if (PERSON_NAME.test(name)) return "alice";
  if (ID_NAME.test(name)) return `${name}_ct_1`;
  let text = `crashtest ${name}`;
  if (typeof schema.minLength === "number") text = text.padEnd(schema.minLength, "x");
  if (typeof schema.maxLength === "number") text = text.slice(0, Math.max(0, schema.maxLength));
  return text;
}

function sampleNumber(schema: Record<string, unknown>, type: string): number {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : 1;
  return type === "integer" ? Math.ceil(minimum) : minimum;
}

function sampleArray(schema: Record<string, unknown>, name: string): unknown[] {
  const minItems = typeof schema.minItems === "number" && Number.isInteger(schema.minItems) ? schema.minItems : 0;
  const count = Math.max(1, minItems);
  return Array.from({ length: count }, () => sampleValue(schema.items, name));
}

function sampleObject(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isObject(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) out[key] = sampleValue(property, key);
  }
  return out;
}

function sampleValue(schema: unknown, name: string): unknown {
  if (!isObject(schema)) return `crashtest ${name}`;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("const" in schema) return schema.const;
  const union = firstNonNullBranch(schema.anyOf) ?? firstNonNullBranch(schema.oneOf);
  if (union !== undefined) return sampleValue(union.branch, name);
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return null;
  if ("$ref" in schema) return `crashtest ${name}`;
  const type = inferredType(schema);
  switch (type) {
    case "integer":
    case "number":
      return sampleNumber(schema, type);
    case "boolean":
      return true;
    case "array":
      return sampleArray(schema, name);
    case "object":
      return sampleObject(schema);
    case "null":
      return null;
    default:
      return sampleString(schema, name);
  }
}

/** One valid input for the tool: every property gets a value, in the order the schema declares them. */
export function sampleInput(schema: JsonSchema | null): Record<string, unknown> {
  if (schema === null) return {};
  const value = sampleValue(schema, "input");
  return isObject(value) ? value : {};
}

/** Top-level string properties that carry free text, which a model may reword when a turn is replayed. */
export function freeTextFields(schema: JsonSchema | null, configured?: string[]): string[] {
  if (configured !== undefined) return [...configured];
  if (schema === null || !isObject(schema.properties)) return [];
  const fields: string[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!isObject(property) || declaredType(property) !== "string") continue;
    if ("enum" in property || "format" in property || "const" in property) continue;
    if (FREE_TEXT_NAME.test(name) || FREE_TEXT_SUFFIX.test(name)) fields.push(name);
  }
  return fields;
}

/** Required scalar properties that are not free text: the business identity of one call, in schema order. */
export function identityFields(schema: JsonSchema | null, freeText: string[], configured?: string[]): string[] {
  if (configured !== undefined) return [...configured];
  if (schema === null || !isObject(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields: string[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!required.includes(name) || freeText.includes(name) || !isObject(property)) continue;
    const type = declaredType(property);
    if (Array.isArray(property.enum) || (type !== undefined && SCALAR_TYPES.has(type))) fields.push(name);
  }
  return fields;
}
