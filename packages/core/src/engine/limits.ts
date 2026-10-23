/** A token bucket: `capacity` tokens of burst, refilled at `refillPerSecond`. The clock is passed in. */
export class TokenBucket {
  private tokens: number;
  private updated: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.updated = now;
  }

  /** Takes `n` tokens if available. Otherwise returns how long until they would be. */
  take(now: number, n = 1): { ok: true } | { ok: false; retryAfterMs: number } {
    const elapsed = Math.max(0, now - this.updated) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.updated = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true };
    }
    const missing = n - this.tokens;
    return { ok: false, retryAfterMs: this.refillPerSecond > 0 ? Math.ceil((missing / this.refillPerSecond) * 1000) : Number.POSITIVE_INFINITY };
  }

  get available(): number {
    return this.tokens;
  }
}
