import { z } from "zod";

/**
 * A small, declarative payload schema for channel definitions (a subset of JSON Schema that is easy to read in a
 * JSON file). `compileSchema` turns it into a Zod validator, once, when a channel is loaded.
 */
export type SchemaNode =
  | { type: "string"; minLength?: number; maxLength?: number; pattern?: string; enum?: string[] }
  | { type: "number" | "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "array"; items: SchemaNode; maxItems?: number }
  | { type: "object"; properties: Record<string, SchemaNode>; required?: string[]; additionalProperties?: boolean }
  | { type: "any" };

export const SchemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("string"), minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(0).optional(), pattern: z.string().max(200).optional(), enum: z.array(z.string()).min(1).optional() }).strict(),
    z.object({ type: z.enum(["number", "integer"]), minimum: z.number().optional(), maximum: z.number().optional() }).strict(),
    z.object({ type: z.literal("boolean") }).strict(),
    z.object({ type: z.literal("array"), items: SchemaNodeSchema, maxItems: z.number().int().min(0).optional() }).strict(),
    z.object({ type: z.literal("object"), properties: z.record(z.string(), SchemaNodeSchema), required: z.array(z.string()).optional(), additionalProperties: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("any") }).strict(),
  ]),
);

const MAX_DEPTH = 8;

/** Compiles a schema node to a Zod validator. Throws on a pattern that is not a valid regular expression. */
export function compileSchema(node: SchemaNode, depth = 0): z.ZodType<unknown> {
  if (depth > MAX_DEPTH) throw new Error(`schema nests deeper than ${MAX_DEPTH} levels`);
  switch (node.type) {
    case "string": {
      if (node.enum) return z.enum(node.enum as [string, ...string[]]);
      let s = z.string();
      if (node.minLength !== undefined) s = s.min(node.minLength);
      if (node.maxLength !== undefined) s = s.max(node.maxLength);
      if (node.pattern !== undefined) s = s.regex(new RegExp(node.pattern));
      return s;
    }
    case "number":
    case "integer": {
      let n = node.type === "integer" ? z.number().int() : z.number();
      if (node.minimum !== undefined) n = n.min(node.minimum);
      if (node.maximum !== undefined) n = n.max(node.maximum);
      return n.refine((v) => Number.isFinite(v), "must be finite");
    }
    case "boolean":
      return z.boolean();
    case "array": {
      let a = z.array(compileSchema(node.items, depth + 1));
      if (node.maxItems !== undefined) a = a.max(node.maxItems);
      return a;
    }
    case "object": {
      const required = new Set(node.required ?? []);
      for (const r of required) if (!(r in node.properties)) throw new Error(`required field "${r}" is not declared in properties`);
      const shape: Record<string, z.ZodType<unknown>> = {};
      for (const [key, child] of Object.entries(node.properties)) {
        const compiled = compileSchema(child, depth + 1);
        shape[key] = required.has(key) ? compiled : compiled.optional();
      }
      const obj = z.object(shape);
      return node.additionalProperties === true ? obj.passthrough() : obj.strict();
    }
    case "any":
      return z.unknown();
  }
}
