/**
 * A fixed-size circular buffer of sequenced items. Pushing into a full buffer overwrites the oldest one, so memory
 * never grows. It is what lets a client that dropped off for a few seconds ask "give me everything after
 * sequence N" and get exactly the events it missed.
 *
 * Sequence numbers start at 1; `head` is the highest sequence pushed (0 when nothing has been).
 */
export class RingBuffer<T extends { seq: number }> {
  /** Grows as events arrive, up to `capacity`: an idle channel with a large retention costs nothing. */
  private readonly slots: Array<T | undefined> = [];
  private next = 0;
  private count = 0;
  private lastSeq = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  }

  /** A ring that already holds `items` (consecutive sequences, oldest first); the next push continues after the last. */
  static startingAt<T extends { seq: number }>(capacity: number, items: T[]): RingBuffer<T> {
    const ring = new RingBuffer<T>(capacity);
    const keep = items.slice(-capacity);
    if (keep.length === 0) return ring;
    ring.lastSeq = (keep[0] as T).seq - 1;
    for (const item of keep) ring.push(item);
    return ring;
  }

  /** Highest sequence number ever pushed. */
  get head(): number {
    return this.lastSeq;
  }

  /** Number of events retained. */
  get size(): number {
    return this.count;
  }

  /** Lowest sequence number still retained, or null when empty. */
  get oldest(): number | null {
    return this.count === 0 ? null : this.lastSeq - this.count + 1;
  }

  /** Stores the next event; its sequence must be `head + 1`. */
  push(item: T): void {
    if (item.seq !== this.lastSeq + 1) throw new RangeError(`expected sequence ${this.lastSeq + 1}, got ${item.seq}`);
    this.slots[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.lastSeq = item.seq;
  }

  /**
   * Everything after `lastSeq`, oldest first. `gap` is true when events between `lastSeq` and the oldest retained
   * one were already overwritten, so the caller cannot be brought fully up to date from this buffer.
   */
  since(lastSeq: number): { events: T[]; gap: boolean } {
    const oldest = this.oldest;
    if (oldest === null) return { events: [], gap: lastSeq < this.lastSeq };
    const gap = lastSeq + 1 < oldest;
    const from = Math.max(lastSeq + 1, oldest);
    const events: T[] = [];
    for (let seq = from; seq <= this.lastSeq; seq++) {
      const item = this.slots[(this.next - 1 - (this.lastSeq - seq) + this.capacity * 2) % this.capacity];
      if (item) events.push(item);
    }
    return { events, gap };
  }
}
