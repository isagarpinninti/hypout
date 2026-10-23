/**
 * Heartbeat bookkeeping for RFC 6455 Ping/Pong. The transport sends a Ping every `intervalMs` and evicts a peer
 * that has not answered with a Pong within `timeoutMs`. This class holds only the decisions (and takes the clock as
 * an argument), so it is exact and testable with no real timers.
 *
 * Defaults match the spec: Ping every 30 seconds, evict after 10 seconds of silence.
 */
export class HeartbeatMonitor {
  private readonly peers = new Map<string, { lastSeen: number; pingSentAt: number | null; lastPing: number }>();

  constructor(
    readonly intervalMs = 30_000,
    readonly timeoutMs = 10_000,
  ) {}

  open(id: string, now: number): void {
    this.peers.set(id, { lastSeen: now, pingSentAt: null, lastPing: now });
  }

  close(id: string): void {
    this.peers.delete(id);
  }

  /** Any frame from the peer proves it is alive (not only Pong). */
  seen(id: string, now: number): void {
    const p = this.peers.get(id);
    if (p) p.lastSeen = now;
  }

  /** A Pong answers the outstanding Ping. Returns the round-trip time in ms, or null if none was outstanding. */
  pong(id: string, now: number): number | null {
    const p = this.peers.get(id);
    if (!p) return null;
    p.lastSeen = now;
    const rtt = p.pingSentAt === null ? null : now - p.pingSentAt;
    p.pingSentAt = null;
    return rtt;
  }

  /** What to do right now: peers to Ping, and peers that missed their deadline and must be evicted. */
  tick(now: number): { ping: string[]; evict: string[] } {
    const ping: string[] = [];
    const evict: string[] = [];
    for (const [id, p] of this.peers) {
      if (p.pingSentAt !== null) {
        if (now - p.pingSentAt >= this.timeoutMs) evict.push(id);
      } else if (now - p.lastPing >= this.intervalMs) {
        p.pingSentAt = now;
        p.lastPing = now;
        ping.push(id);
      }
    }
    for (const id of evict) this.peers.delete(id);
    return { ping, evict };
  }

  get size(): number {
    return this.peers.size;
  }
}
