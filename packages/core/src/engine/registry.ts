import { z } from "zod";
import { SchemaNodeSchema, compileSchema, type SchemaNode } from "./schema";

const access = z.enum(["public", "token"]);

/** A channel definition: one file under `channels/`. It describes a namespace; channels are `namespace` or `namespace:id`. */
export const ChannelDefinitionSchema = z
  .object({
    namespace: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "lowercase letters, digits, - and _ (start with a letter)"),
    description: z.string().max(300).optional(),
    access: z
      .object({
        subscribe: access.default("public"),
        publish: z.enum(["public", "token", "server"]).default("token"),
        presence: z.enum(["public", "token", "off"]).default("off"),
      })
      .default({ subscribe: "public", publish: "token", presence: "off" }),
    /** Allowed event names and their payload schemas. Empty means any event name and any payload. */
    events: z.record(z.string().min(1).max(64), SchemaNodeSchema).default({}),
    rateLimit: z.object({ capacity: z.number().int().min(1).max(10_000).default(30), refillPerSecond: z.number().min(0.1).max(10_000).default(10) }).default({ capacity: 30, refillPerSecond: 10 }),
    retention: z.object({ events: z.number().int().min(1).max(100_000).default(500) }).default({ events: 500 }),
    presence: z.object({ maxMembers: z.number().int().min(1).max(100_000).default(1000) }).default({ maxMembers: 1000 }),
    maxPayloadBytes: z.number().int().min(16).max(1024 * 1024).optional(),
  })
  .strict();

export type ChannelDefinition = z.infer<typeof ChannelDefinitionSchema>;

/** A channel name is `namespace` or `namespace:id`, id being 1 to 64 of letters, digits, `_`, `.`, `-`, `:`, `=`, `@`. */
const CHANNEL_NAME = /^([a-z][a-z0-9_-]{0,31})(?::([A-Za-z0-9_.:=@-]{1,64}))?$/;
export const MAX_CHANNEL_NAME = 128;

export interface ResolvedChannel {
  name: string;
  namespace: string;
  id: string | null;
  definition: ChannelDefinition;
  validators: Map<string, z.ZodType<unknown>>;
}

export type ResolveResult = { ok: true; channel: ResolvedChannel } | { ok: false; reason: "syntax" | "unknown_namespace"; message: string };

/** The set of channel definitions the server was started with, compiled and ready to resolve names against. */
export class ChannelRegistry {
  private readonly byNamespace = new Map<string, { definition: ChannelDefinition; validators: Map<string, z.ZodType<unknown>> }>();

  constructor(definitions: Array<z.input<typeof ChannelDefinitionSchema>> = []) {
    for (const d of definitions) this.add(d);
  }

  /** Validates and registers a definition (replacing one with the same namespace). Throws with a readable message. */
  add(input: z.input<typeof ChannelDefinitionSchema>): ChannelDefinition {
    const parsed = ChannelDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new Error(`invalid channel definition${typeof (input as { namespace?: unknown })?.namespace === "string" ? ` "${(input as { namespace: string }).namespace}"` : ""}: ${i ? `${i.path.join(".") || "definition"}: ${i.message}` : "unknown problem"}`);
    }
    const definition = parsed.data;
    const validators = new Map<string, z.ZodType<unknown>>();
    for (const [name, node] of Object.entries(definition.events)) {
      try {
        validators.set(name, compileSchema(node as SchemaNode));
      } catch (e) {
        throw new Error(`invalid channel definition "${definition.namespace}": event "${name}": ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    }
    this.byNamespace.set(definition.namespace, { definition, validators });
    return definition;
  }

  remove(namespace: string): boolean {
    return this.byNamespace.delete(namespace);
  }

  namespaces(): string[] {
    return [...this.byNamespace.keys()].sort();
  }

  definitions(): ChannelDefinition[] {
    return this.namespaces().map((n) => (this.byNamespace.get(n) as { definition: ChannelDefinition }).definition);
  }

  get(namespace: string): ChannelDefinition | undefined {
    return this.byNamespace.get(namespace)?.definition;
  }

  /** Parses a channel name and finds its definition. */
  resolve(name: string): ResolveResult {
    if (name.length > MAX_CHANNEL_NAME) return { ok: false, reason: "syntax", message: `channel names are at most ${MAX_CHANNEL_NAME} characters` };
    const m = CHANNEL_NAME.exec(name);
    if (!m) return { ok: false, reason: "syntax", message: 'channel names look like "namespace" or "namespace:id" (lowercase namespace; id of letters, digits and _ . : = @ -)' };
    const namespace = m[1] as string;
    const entry = this.byNamespace.get(namespace);
    if (!entry) return { ok: false, reason: "unknown_namespace", message: `no channel namespace "${namespace}" is defined` };
    return { ok: true, channel: { name, namespace, id: m[2] ?? null, definition: entry.definition, validators: entry.validators } };
  }
}
