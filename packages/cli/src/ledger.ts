import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** One line of the audit ledger. `hash` covers every other field, including the previous entry's hash. */
export interface LedgerEntry {
  n: number;
  ts: number;
  channel: string;
  seq: number;
  ev: string;
  from: string;
  /** SHA-256 of the event data (the data itself is not kept in the ledger). */
  dataHash: string;
  prev: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const entryHash = (e: Omit<LedgerEntry, "hash">): string => sha256(JSON.stringify([e.n, e.ts, e.channel, e.seq, e.ev, e.from, e.dataHash, e.prev]));

/** Stable JSON (sorted keys) so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * An append-only, hash-chained log of every published event. Editing, removing or reordering a line breaks the
 * chain from that point on, which `verifyLedger` reports.
 */
export class Ledger {
  private n = 0;
  private prev = GENESIS;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const check = verifyLedger(path);
      if (!check.ok) throw new Error(`ledger ${path} is corrupt at entry ${check.brokenAt}: ${check.reason}`);
      this.n = check.entries;
      this.prev = check.head;
    }
  }

  get head(): string {
    return this.prev;
  }

  get entries(): number {
    return this.n;
  }

  append(info: { ts: number; channel: string; seq: number; ev: string; from: string; data: unknown }): LedgerEntry {
    const body = { n: this.n + 1, ts: info.ts, channel: info.channel, seq: info.seq, ev: info.ev, from: info.from, dataHash: sha256(canonicalJson(info.data)), prev: this.prev };
    const entry: LedgerEntry = { ...body, hash: entryHash(body) };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.n = entry.n;
    this.prev = entry.hash;
    return entry;
  }
}

export type LedgerCheck = { ok: true; entries: number; head: string } | { ok: false; entries: number; head: string; brokenAt: number; reason: string };

export function verifyLedger(path: string): LedgerCheck {
  if (!existsSync(path)) return { ok: true, entries: 0, head: GENESIS };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const at = i + 1;
    let e: LedgerEntry;
    try {
      e = JSON.parse(lines[i] as string) as LedgerEntry;
    } catch {
      return { ok: false, entries: i, head: prev, brokenAt: at, reason: "line is not valid JSON" };
    }
    if (e.n !== at) return { ok: false, entries: i, head: prev, brokenAt: at, reason: `expected entry ${at}, found ${String(e.n)} (an entry was removed or reordered)` };
    if (e.prev !== prev) return { ok: false, entries: i, head: prev, brokenAt: at, reason: "does not continue the previous entry" };
    const { hash, ...body } = e;
    if (entryHash(body) !== hash) return { ok: false, entries: i, head: prev, brokenAt: at, reason: "contents do not match their hash (the entry was edited)" };
    prev = hash;
  }
  return { ok: true, entries: lines.length, head: prev };
}
