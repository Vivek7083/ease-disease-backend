export interface LimitDecision {
  allowed: boolean;
  /** Milliseconds until the oldest counted hit leaves the window (0 when allowed). */
  retryAfterMs: number;
}

/**
 * In-memory sliding-window limiter: at most `limit` hits per `windowMs` per key. Per process only
 * (see api-flow.md §7: "per instance"), so it is a cost limiter, not a security boundary.
 * Memory is bounded: at most `maxKeys` keys are kept, so a flood of distinct addresses cannot grow it forever.
 */
export class SlidingWindowLimiter {
  private readonly hitsByKey = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = 50_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError('windowMs must be a positive integer');
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new RangeError('maxKeys must be a positive integer');
  }

  /** Counts a hit for `key` and says whether it is within the limit. Denied hits are not counted. */
  hit(key: string): LimitDecision {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hitsByKey.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      this.hitsByKey.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(1, recent[0]! + this.windowMs - now) };
    }

    recent.push(now);
    // Re-inserting moves the key to the end, so the oldest-touched keys are the ones evicted first.
    this.hitsByKey.delete(key);
    this.hitsByKey.set(key, recent);
    if (this.hitsByKey.size > this.maxKeys) this.shrink(cutoff);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Number of keys currently tracked (for tests and metrics). */
  get size(): number {
    return this.hitsByKey.size;
  }

  private shrink(cutoff: number): void {
    for (const [key, hits] of this.hitsByKey) {
      if (hits.every((t) => t <= cutoff)) this.hitsByKey.delete(key);
    }
    // Still too many live keys: drop the least recently touched ones.
    for (const key of this.hitsByKey.keys()) {
      if (this.hitsByKey.size <= this.maxKeys) break;
      this.hitsByKey.delete(key);
    }
  }
}
