import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './sliding-window-limiter.js';

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('SlidingWindowLimiter', () => {
  it('allows exactly `limit` hits in the window, then denies', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(3, 60_000, c.now);
    expect([1, 2, 3].map(() => limiter.hit('a').allowed)).toEqual([true, true, true]);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('keeps keys independent', () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, clock().now);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('frees capacity as hits slide out of the window', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 60_000, c.now);
    limiter.hit('a'); // t0
    c.advance(30_000);
    limiter.hit('a'); // t0 + 30s
    expect(limiter.hit('a').allowed).toBe(false);
    c.advance(30_001); // first hit is now outside the window
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('resets completely after a full window', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 60_000, c.now);
    limiter.hit('a');
    limiter.hit('a');
    expect(limiter.hit('a').allowed).toBe(false);
    c.advance(60_001);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('does not count denied hits, so a hammering client recovers on schedule', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 60_000, c.now);
    limiter.hit('a');
    for (let i = 0; i < 50; i++) {
      c.advance(100);
      expect(limiter.hit('a').allowed).toBe(false);
    }
    c.advance(60_000 - 5_000 + 1); // 60s after the only counted hit
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('reports a sensible retry delay', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 60_000, c.now);
    limiter.hit('a');
    c.advance(20_000);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterMs: 40_000 });
    expect(limiter.hit('b')).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('allows the documented 120 per minute and denies the 121st', () => {
    const limiter = new SlidingWindowLimiter(120, 60_000, clock().now);
    const results = Array.from({ length: 121 }, () => limiter.hit('203.0.113.7').allowed);
    expect(results.slice(0, 120).every(Boolean)).toBe(true);
    expect(results[120]).toBe(false);
  });

  describe('memory is bounded', () => {
    it('never tracks more than maxKeys keys, even under a flood of distinct addresses', () => {
      const limiter = new SlidingWindowLimiter(5, 60_000, clock().now, 100);
      for (let i = 0; i < 10_000; i++) limiter.hit(`2001:db8::${i.toString(16)}`);
      expect(limiter.size).toBeLessThanOrEqual(100);
    });

    it('drops expired keys first when shrinking', () => {
      const c = clock();
      const limiter = new SlidingWindowLimiter(5, 60_000, c.now, 3);
      limiter.hit('old1');
      limiter.hit('old2');
      c.advance(61_000);
      limiter.hit('live1');
      limiter.hit('live2'); // 4 keys > 3: the two expired ones go
      expect(limiter.size).toBe(2);
      expect(limiter.hit('live1').allowed).toBe(true);
    });

    it('keeps a still-limited active client limited while others churn', () => {
      const limiter = new SlidingWindowLimiter(1, 60_000, clock().now, 100);
      limiter.hit('attacker');
      for (let i = 0; i < 50; i++) limiter.hit(`other${i}`);
      expect(limiter.hit('attacker').allowed).toBe(false);
    });
  });

  it.each([
    [0, 1000, 10],
    [1.5, 1000, 10],
    [1, 0, 10],
    [1, 1000, 0],
  ])('rejects invalid settings (limit %s, window %s, maxKeys %s)', (limit, windowMs, maxKeys) => {
    expect(() => new SlidingWindowLimiter(limit, windowMs, Date.now, maxKeys)).toThrow(RangeError);
  });
});
