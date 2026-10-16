import { describe, expect, it } from 'vitest';
import { TXNID_PATTERN, TXNID_PREFIX, generateTxnid } from './payu-txnid.js';

const fixedRandom = (...bytes: number[]) => () => Uint8Array.from(bytes);

describe('generateTxnid', () => {
  it('has the documented shape: prefix + 13-digit epoch ms + 4 random characters', () => {
    expect(generateTxnid(1792200600123, fixedRandom(20, 7, 2, 31))).toBe('EDTX_PU_1792200600123M72Z'); // M=20, 7, 2, Z=31
  });

  it('maps bytes onto the 32-character alphabet without bias (byte % 32)', () => {
    expect(generateTxnid(1792200600123, fixedRandom(0, 1, 2, 3))).toBe('EDTX_PU_17922006001230123');
    expect(generateTxnid(1792200600123, fixedRandom(32, 33, 34, 35))).toBe('EDTX_PU_17922006001230123');
    expect(generateTxnid(1792200600123, fixedRandom(255, 254, 253, 252))).toBe('EDTX_PU_1792200600123ZYXW');
  });

  it('is always exactly 25 characters, matches the pattern, and uses only characters PayU-safe in a txnid', () => {
    for (let i = 0; i < 2000; i++) {
      const id = generateTxnid(1_700_000_000_000 + i * 86_400_000);
      expect(id).toHaveLength(25);
      expect(id).toMatch(TXNID_PATTERN);
      expect(id).toMatch(/^[A-Za-z0-9_]+$/);
      expect(id.startsWith(TXNID_PREFIX)).toBe(true);
    }
  });

  it('sorts in creation order, as plain strings', () => {
    const ids = [1_700_000_000_000, 1_700_000_000_001, 1_700_000_001_000, 1_792_200_600_123, 9_999_999_999_999].map((t) =>
      generateTxnid(t, fixedRandom(0, 0, 0, 0)),
    );
    expect([...ids].sort()).toEqual(ids);
  });

  it('uses fresh randomness on every call (different calls in the same millisecond usually differ)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTxnid(1_792_200_600_123)));
    expect(ids.size).toBeGreaterThan(40); // 20 random bits: a few collisions are possible, and the DB index catches them
  });

  it.each([0, -1, 1.5, Number.NaN, 999_999_999_999, 10_000_000_000_000, Number.MAX_SAFE_INTEGER])(
    'rejects the timestamp %s (it would not give a 13-digit time)',
    (t) => {
      expect(() => generateTxnid(t)).toThrow(RangeError);
    },
  );

  it('rejects a random source that returns the wrong number of bytes', () => {
    expect(() => generateTxnid(1_792_200_600_123, fixedRandom(1, 2, 3))).toThrow(RangeError);
  });

  it('the pattern rejects look-alikes', () => {
    for (const bad of ['EDTX_PU_1792200600123K7Q', 'EDTX_PU_1792200600123K7Q22', 'EDTX_PU_179220060012K7Q2', 'edtx_pu_1792200600123K7Q2', 'EDTX_PU_1792200600123K7QI', 'EDTX_PU_1792200600123K7Q|']) {
      expect(bad).not.toMatch(TXNID_PATTERN);
    }
  });
});
