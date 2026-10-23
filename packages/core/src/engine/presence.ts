import type { Json, Member, PresenceOp } from "../protocol/messages";

/** The field that records whether a member is present. `false` is a tombstone. */
export const ALIVE = "$alive";

interface Register {
  v: Json;
  ts: number;
  a: string;
}

/** Total order on registers: higher timestamp wins, then actor id, then the value itself (so ties are deterministic). */
function wins(next: { v: Json; ts: number; a: string }, current: Register): boolean {
  if (next.ts !== current.ts) return next.ts > current.ts;
  if (next.a !== current.a) return next.a > current.a;
  return JSON.stringify(next.v) > JSON.stringify(current.v);
}

/**
 * Presence as a state-based CRDT: a map from member to a map from field to a last-writer-wins register. Applying
 * operations is commutative, associative and idempotent, so servers and clients converge on the same roster no
 * matter the order, duplication or replay of updates. That is the whole point: there is no "conflict" to resolve.
 */
export class PresenceCRDT {
  private readonly members_ = new Map<string, Map<string, Register>>();

  /** Applies one operation. Returns true if it changed the state (false for stale or duplicate operations). */
  apply(op: PresenceOp): boolean {
    let fields = this.members_.get(op.k);
    if (!fields) {
      fields = new Map();
      this.members_.set(op.k, fields);
    }
    const current = fields.get(op.f);
    if (current && !wins(op, current)) return false;
    fields.set(op.f, { v: op.v, ts: op.ts, a: op.a });
    return true;
  }

  /** Applies many; returns the ones that changed something. */
  applyAll(ops: readonly PresenceOp[]): PresenceOp[] {
    return ops.filter((op) => this.apply(op));
  }

  /** Folds another replica's state into this one. */
  merge(other: PresenceCRDT): void {
    this.applyAll(other.toOps());
  }

  private alive(fields: Map<string, Register>): boolean {
    return fields.get(ALIVE)?.v === true;
  }

  has(key: string): boolean {
    const f = this.members_.get(key);
    return !!f && this.alive(f);
  }

  member(key: string): Member | undefined {
    const f = this.members_.get(key);
    if (!f || !this.alive(f)) return undefined;
    return toMember(key, f);
  }

  /** The current roster: present members only, sorted by key. */
  members(): Member[] {
    const out: Member[] = [];
    for (const [key, f] of this.members_) if (this.alive(f)) out.push(toMember(key, f));
    return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  }

  get size(): number {
    let n = 0;
    for (const f of this.members_.values()) if (this.alive(f)) n++;
    return n;
  }

  /** The whole state, as operations, in a deterministic order. Replaying it into an empty replica reproduces this one. */
  toOps(): PresenceOp[] {
    const ops: PresenceOp[] = [];
    for (const [k, f] of this.members_) for (const [field, r] of f) ops.push({ k, f: field, v: r.v, ts: r.ts, a: r.a });
    return ops.sort((x, y) => (x.k !== y.k ? (x.k < y.k ? -1 : 1) : x.f !== y.f ? (x.f < y.f ? -1 : 1) : 0));
  }

  /** The operations that make up the current roster only (no tombstones), for snapshots sent to new subscribers. */
  liveOps(): PresenceOp[] {
    return this.toOps().filter((op) => this.has(op.k));
  }

  /** Drops tombstones older than `before` (a Lamport timestamp). Safe once no replica can still be behind it. */
  gc(before: number): number {
    let removed = 0;
    for (const [key, f] of this.members_) {
      const alive = f.get(ALIVE);
      if (alive && alive.v === false && alive.ts < before) {
        this.members_.delete(key);
        removed++;
      }
    }
    return removed;
  }

  equals(other: PresenceCRDT): boolean {
    return JSON.stringify(this.toOps()) === JSON.stringify(other.toOps());
  }
}

function toMember(key: string, f: Map<string, Register>): Member {
  const state: Record<string, Json> = {};
  for (const [field, r] of [...f].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (field !== ALIVE) state[field] = r.v;
  return { key, state };
}

/** What changed between two rosters: used to tell subscribers who joined, left or updated. */
export function diffMembers(before: Member[], after: Member[]): { joined: Member[]; left: string[]; updated: Member[] } {
  const prev = new Map(before.map((m) => [m.key, m]));
  const next = new Map(after.map((m) => [m.key, m]));
  const joined = after.filter((m) => !prev.has(m.key));
  const left = before.filter((m) => !next.has(m.key)).map((m) => m.key);
  const updated = after.filter((m) => {
    const p = prev.get(m.key);
    return p !== undefined && JSON.stringify(p.state) !== JSON.stringify(m.state);
  });
  return { joined, left, updated };
}

/** A Lamport clock: timestamps that respect causality without a shared clock. */
export class LamportClock {
  constructor(private time = 0) {}

  tick(): number {
    return ++this.time;
  }

  /** Moves the clock past a timestamp seen from elsewhere. */
  observe(ts: number): void {
    if (ts > this.time) this.time = ts;
  }

  get now(): number {
    return this.time;
  }
}
