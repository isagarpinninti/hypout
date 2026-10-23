import type { Json, GateCode } from "../protocol/messages";
import type { ChannelRegistry, ResolvedChannel } from "./registry";
import { TokenBucket } from "./limits";
import { allows, type Op, type TokenClaims } from "./tokens";

/** What a connection is allowed to do: the verified claims of its token, or nothing (anonymous). */
export type Principal = Pick<TokenClaims, "sub" | "name" | "avatar" | "caps" | "admin">;

export interface GateFailure {
  code: GateCode;
  reason: string;
  message: string;
  retryAfterMs?: number;
}

export type GateResult<T = undefined> = ({ ok: true } & (T extends undefined ? object : { value: T })) | ({ ok: false } & GateFailure);

const fail = (code: GateCode, reason: string, message: string, retryAfterMs?: number): { ok: false } & GateFailure => ({ ok: false, code, reason, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

/** HP-101: the channel name is well-formed and its namespace is defined. */
export function gate101Topic(registry: ChannelRegistry, name: string): GateResult<ResolvedChannel> {
  const r = registry.resolve(name);
  if (!r.ok) return fail("HP-101", r.reason, r.message);
  return { ok: true, value: r.channel };
}

/** HP-102: the event is allowed on this channel and its payload satisfies the schema. */
export function gate102Schema(channel: ResolvedChannel, ev: string, data: unknown): GateResult {
  const events = channel.definition.events;
  if (Object.keys(events).length === 0) return { ok: true };
  const validator = channel.validators.get(ev);
  if (!validator) return fail("HP-102", "unknown_event", `channel "${channel.namespace}" accepts only: ${Object.keys(events).join(", ")}`);
  const parsed = validator.safeParse(data);
  if (parsed.success) return { ok: true };
  const issue = parsed.error.issues[0];
  return fail("HP-102", "schema", `payload for "${ev}" is invalid${issue ? `: ${issue.path.join(".") || "value"}: ${issue.message}` : ""}`);
}

/** HP-103: the connection still has tokens in its bucket. */
export function gate103Rate(bucket: TokenBucket, now: number): GateResult {
  const taken = bucket.take(now);
  return taken.ok ? { ok: true } : fail("HP-103", "rate_limited", "too many messages; slow down", taken.retryAfterMs);
}

/**
 * HP-104: the connection may perform this operation on this channel. Public channels need no token for the
 * operations marked public; everything else needs a token with a matching capability. Admins pass.
 */
export function gate104Access(channel: ResolvedChannel, principal: Principal | null, op: Op): GateResult {
  if (principal?.admin) return { ok: true };
  const a = channel.definition.access;
  const mode = op === "sub" ? a.subscribe : op === "pub" ? a.publish : a.presence;
  if (mode === "off") return fail("HP-104", "presence_off", `presence is not enabled on "${channel.namespace}"`);
  if (mode === "server") return fail("HP-104", "server_only", `only the server may publish to "${channel.namespace}"`);
  if (mode === "public") return { ok: true };
  if (!principal) return fail("HP-104", "token_required", `a token is required to ${op === "sub" ? "subscribe to" : op === "pub" ? "publish to" : "use presence on"} "${channel.name}"`);
  if (!allows(principal, op, channel.name)) return fail("HP-104", "forbidden", `this token does not allow "${op}" on "${channel.name}"`);
  return { ok: true };
}

/** HP-105: a replay cursor is a whole number from 0 up to the channel's current sequence. */
export function gate105Replay(lastSeq: unknown, head: number): GateResult {
  if (typeof lastSeq !== "number" || !Number.isInteger(lastSeq) || lastSeq < 0) return fail("HP-105", "cursor_invalid", "lastSeq must be a whole number of 0 or more");
  if (lastSeq > head) return fail("HP-105", "cursor_ahead", `lastSeq ${lastSeq} is ahead of the channel (current sequence ${head}); the server may have restarted, so resubscribe without a cursor`);
  return { ok: true };
}

export const DEFAULT_MAX_PAYLOAD = 64 * 1024;

/** HP-106: the message fits under the size ceiling (default 64 KiB). */
export function gate106Size(bytes: number, limit: number): GateResult {
  return bytes <= limit ? { ok: true } : fail("HP-106", "too_large", `message is ${bytes} bytes; the limit is ${limit}`);
}

/* ───────────────────────── pre-flight report ───────────────────────── */

export interface GateCheck {
  code: GateCode;
  name: string;
  ok: boolean;
  /** True when the gate did not apply to this request. */
  skipped: boolean;
  message: string;
}

export interface GateReport {
  ok: boolean;
  checks: GateCheck[];
}

export interface PreflightRequest {
  op: Op;
  channel: string;
  event?: string;
  data?: Json;
  lastSeq?: number;
  principal: Principal | null;
  /** Size in bytes of the message as it would be sent. */
  bytes: number;
  maxPayload?: number;
  /** The channel's current sequence, for HP-105. */
  head?: number;
  bucket?: TokenBucket;
  now?: number;
}

/**
 * Runs every gate against a hypothetical request and reports each one, without stopping at the first failure.
 * The Studio uses it to show exactly why a publish or subscribe would be refused.
 */
export function preflight(registry: ChannelRegistry, req: PreflightRequest): GateReport {
  const checks: GateCheck[] = [];
  const now = req.now ?? Date.now();
  const add = (code: GateCode, name: string, r: { ok: boolean; message?: string }, skipped = false, okMessage = "ok"): void => {
    checks.push({ code, name, ok: r.ok, skipped, message: r.ok ? okMessage : (r.message ?? "failed") });
  };

  const size = gate106Size(req.bytes, req.maxPayload ?? DEFAULT_MAX_PAYLOAD);
  const topic = gate101Topic(registry, req.channel);
  add("HP-101", "Topic and namespace", topic, false, topic.ok ? `namespace "${topic.value.namespace}"` : undefined);
  if (!topic.ok) {
    add("HP-102", "Payload schema", { ok: true }, true, "skipped: no channel");
    add("HP-103", "Rate limit", { ok: true }, true, "skipped: no channel");
    add("HP-104", "Access (ACL)", { ok: true }, true, "skipped: no channel");
    add("HP-105", "Replay cursor", { ok: true }, true, "skipped: no channel");
    add("HP-106", "Payload size", size);
    return { ok: false, checks };
  }
  const channel = topic.value;
  if (req.op === "pub" && req.event !== undefined) add("HP-102", "Payload schema", gate102Schema(channel, req.event, req.data));
  else add("HP-102", "Payload schema", { ok: true }, true, "skipped: only publishes carry a payload");
  if (req.bucket) add("HP-103", "Rate limit", gate103Rate(req.bucket, now));
  else add("HP-103", "Rate limit", { ok: true }, true, "skipped: no connection bucket given");
  add("HP-104", "Access (ACL)", gate104Access(channel, req.principal, req.op));
  if (req.op === "sub" && req.lastSeq !== undefined) add("HP-105", "Replay cursor", gate105Replay(req.lastSeq, req.head ?? 0));
  else add("HP-105", "Replay cursor", { ok: true }, true, "skipped: no replay cursor");
  add("HP-106", "Payload size", size);
  return { ok: checks.every((c) => c.ok), checks };
}

export { TokenBucket };
