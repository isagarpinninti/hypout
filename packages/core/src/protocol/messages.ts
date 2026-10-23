import { z } from "zod";

/** Anything JSON can carry. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const PROTOCOL_VERSION = "hypout.v1";

/* ───────────────────────── presence ───────────────────────── */

/** One field of one member, as a CRDT operation: last-writer-wins by (ts, actor). */
export interface PresenceOp {
  /** Member key (the connection id). */
  k: string;
  /** Field name. `$alive` is the membership flag. */
  f: string;
  v: Json;
  /** Lamport timestamp. */
  ts: number;
  /** Actor that issued the operation (breaks ties between equal timestamps). */
  a: string;
}

export interface Member {
  key: string;
  state: Record<string, Json>;
}

/* ───────────────────────── client to server ───────────────────────── */

const channel = z.string().min(1).max(128);
const mid = z.string().min(1).max(64).optional();

export const ClientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), ch: channel, lastSeq: z.number().optional(), mid }),
  z.object({ t: z.literal("unsub"), ch: channel, mid }),
  z.object({ t: z.literal("pub"), ch: channel, ev: z.string().min(1).max(64), data: z.unknown(), mid }),
  z.object({ t: z.literal("presence"), ch: channel, op: z.enum(["set", "get"]), state: z.record(z.string(), z.unknown()).optional(), mid }),
  z.object({ t: z.literal("auth"), token: z.string().min(1).max(4096), mid }),
  z.object({ t: z.literal("ping"), ts: z.number().optional() }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ───────────────────────── server to client ───────────────────────── */

export type GateCode = "HP-101" | "HP-102" | "HP-103" | "HP-104" | "HP-105" | "HP-106";

export interface HypoutEvent {
  seq: number;
  ts: number;
  ev: string;
  data: Json;
  /** The connection that published it, or "server" for REST publishes. */
  from: string;
}

export type ServerMessage =
  | { t: "welcome"; cid: string; serverTime: number; heartbeat: { intervalMs: number; timeoutMs: number }; maxPayload: number; authenticated: boolean }
  | { t: "sub.ok"; ch: string; seq: number; oldest: number | null; replayed: number; gap: boolean; mid?: string }
  | { t: "unsub.ok"; ch: string; mid?: string }
  | { t: "event"; ch: string; seq: number; ts: number; ev: string; data: Json; from: string; replay?: boolean }
  | { t: "ack"; ch: string; seq: number; mid?: string }
  | { t: "presence.snapshot"; ch: string; members: Member[]; ops: PresenceOp[] }
  | { t: "presence.diff"; ch: string; ops: PresenceOp[]; joined: Member[]; left: string[]; updated: Member[] }
  | { t: "auth.ok"; sub: string; admin: boolean; mid?: string }
  | { t: "pong"; ts: number | null; serverTime: number }
  | { t: "error"; code: GateCode | "HP-000"; reason: string; message: string; ch?: string; mid?: string; retryAfterMs?: number };

export function parseClientMessage(text: string): { ok: true; message: ClientMessage } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  const parsed = ClientMessageSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: issue ? `${issue.path.join(".") || "message"}: ${issue.message}` : "malformed message" };
  }
  return { ok: true, message: parsed.data };
}
