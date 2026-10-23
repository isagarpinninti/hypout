/** Deterministic PRNG so a chaos run can be repeated exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChaosSettings {
  /** Probability (0 to 1) that a server-to-client event or presence frame is silently dropped. */
  dropRate: number;
  /** Fixed delay added to delivered frames. */
  delayMs: number;
  /** Up to this much extra random delay. */
  jitterMs: number;
  seed: number;
}

export const CHAOS_OFF: ChaosSettings = { dropRate: 0, delayMs: 0, jitterMs: 0, seed: 1 };

export type ChaosDecision = { drop: true } | { drop: false; delayMs: number };

/**
 * Makes the network lossy on demand, so reconnect and replay can be watched working. Only event and presence
 * frames are touched; handshakes, acks, errors and control frames always get through.
 */
export class ChaosSimulator {
  private settings: ChaosSettings = { ...CHAOS_OFF };
  private rand = mulberry32(1);
  dropped = 0;
  delayed = 0;

  get current(): ChaosSettings {
    return { ...this.settings };
  }

  get active(): boolean {
    return this.settings.dropRate > 0 || this.settings.delayMs > 0 || this.settings.jitterMs > 0;
  }

  set(next: Partial<ChaosSettings>): ChaosSettings {
    const merged = { ...this.settings, ...next };
    if (!(merged.dropRate >= 0 && merged.dropRate <= 1)) throw new RangeError("dropRate must be between 0 and 1");
    if (!(merged.delayMs >= 0 && merged.delayMs <= 10_000)) throw new RangeError("delayMs must be between 0 and 10000");
    if (!(merged.jitterMs >= 0 && merged.jitterMs <= 10_000)) throw new RangeError("jitterMs must be between 0 and 10000");
    if (!Number.isInteger(merged.seed)) throw new RangeError("seed must be an integer");
    if (next.seed !== undefined || next.dropRate !== undefined) this.rand = mulberry32(merged.seed);
    this.settings = merged;
    return this.current;
  }

  reset(): void {
    this.settings = { ...CHAOS_OFF };
    this.rand = mulberry32(1);
    this.dropped = 0;
    this.delayed = 0;
  }

  decide(): ChaosDecision {
    if (this.settings.dropRate > 0 && this.rand() < this.settings.dropRate) {
      this.dropped++;
      return { drop: true };
    }
    const delayMs = this.settings.delayMs + (this.settings.jitterMs > 0 ? Math.floor(this.rand() * (this.settings.jitterMs + 1)) : 0);
    if (delayMs > 0) this.delayed++;
    return { drop: false, delayMs };
  }
}
