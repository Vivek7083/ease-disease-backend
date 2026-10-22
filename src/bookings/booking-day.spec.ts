import { describe, expect, it } from 'vitest';
import { istDayStart, istNextDayStart } from './booking-day.js';

const iso = (date: Date) => date.toISOString();

describe('istDayStart', () => {
  it.each([
    // [instant, start of its India day (as UTC)]
    ['2026-10-22T10:00:00.000Z', '2026-10-21T18:30:00.000Z'], // 15:30 IST on the 22nd
    ['2026-10-21T18:30:00.000Z', '2026-10-21T18:30:00.000Z'], // exactly 00:00 IST on the 22nd
    ['2026-10-21T18:29:59.999Z', '2026-10-20T18:30:00.000Z'], // 23:59:59.999 IST on the 21st
    ['2026-10-22T18:29:59.999Z', '2026-10-21T18:30:00.000Z'], // last millisecond of the 22nd IST
    ['2026-10-22T00:00:00.000Z', '2026-10-21T18:30:00.000Z'], // UTC midnight is 05:30 IST the same IST date
    ['2026-10-21T19:00:00.000Z', '2026-10-21T18:30:00.000Z'], // 19:00 UTC is 00:30 IST: UTC date 21st, IST date 22nd
    ['2026-12-31T18:30:00.000Z', '2026-12-31T18:30:00.000Z'], // 00:00 IST on 1 Jan 2027
    ['2026-12-31T18:29:59.999Z', '2026-12-30T18:30:00.000Z'], // last moment of 31 Dec IST
    ['2028-02-29T12:00:00.000Z', '2028-02-28T18:30:00.000Z'], // leap day
  ])('%s begins its India day at %s', (instant, start) => {
    expect(iso(istDayStart(new Date(instant)))).toBe(start);
  });

  it('is idempotent and always 18:30 UTC', () => {
    for (const t of [0, 1, 86_399_999, 1_700_000_000_000, 1_790_000_000_123]) {
      const start = istDayStart(new Date(t));
      expect(istDayStart(start).getTime()).toBe(start.getTime());
      expect(start.getUTCHours()).toBe(18);
      expect(start.getUTCMinutes()).toBe(30);
    }
  });
});

describe('istNextDayStart', () => {
  it('is exactly 24 hours after the day start, with the day half-open', () => {
    const now = new Date('2026-10-22T10:00:00.000Z');
    expect(iso(istNextDayStart(now))).toBe('2026-10-22T18:30:00.000Z');
    expect(istDayStart(istNextDayStart(now)).getTime()).toBe(istNextDayStart(now).getTime());
    expect(iso(istDayStart(new Date(istNextDayStart(now).getTime() - 1)))).toBe('2026-10-21T18:30:00.000Z');
  });
});
