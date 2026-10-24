import { describe, expect, it } from 'vitest';
import { advisoriesFrom, evaluate, type Advisory } from './audit-gate.js';

const advisory = (id: string, severity: string): Advisory => ({ id, severity, title: `t-${id}`, packageName: 'pkg' });
const allowance = (id: string, expires: string) => ({ id, reason: 'not reachable', expires });

describe('advisoriesFrom', () => {
  it('reads the advisory objects from every package and ignores package-name references', () => {
    const report = {
      vulnerabilities: {
        multer: { via: [{ url: 'https://github.com/advisories/GHSA-aaaa', severity: 'high', title: 'DoS', name: 'multer' }] },
        'platform-express': { via: ['multer'] },
        core: { via: ['platform-express'] },
      },
    };
    expect(advisoriesFrom(report)).toEqual([{ id: 'GHSA-aaaa', severity: 'high', title: 'DoS', packageName: 'multer' }]);
  });

  it('lists an advisory once even when several packages carry it', () => {
    const via = [{ url: 'https://github.com/advisories/GHSA-bbbb', severity: 'high', title: 'x', name: 'a' }];
    expect(advisoriesFrom({ vulnerabilities: { a: { via }, b: { via } } })).toHaveLength(1);
  });

  it('copes with an empty report', () => {
    expect(advisoriesFrom({})).toEqual([]);
  });
});

describe('evaluate', () => {
  const today = '2026-10-24';

  it('blocks a high or critical advisory that is not allowed', () => {
    const result = evaluate([advisory('GHSA-1', 'high'), advisory('GHSA-2', 'critical')], [], today);
    expect(result.blocked.map((a) => a.id)).toEqual(['GHSA-1', 'GHSA-2']);
  });

  it('lets moderate and low advisories through', () => {
    const result = evaluate([advisory('GHSA-3', 'moderate'), advisory('GHSA-4', 'low')], [], today);
    expect(result).toEqual({ blocked: [], allowed: [], expired: [] });
  });

  it('allows an advisory on the allowlist until its last day, including that day', () => {
    expect(evaluate([advisory('GHSA-5', 'high')], [allowance('GHSA-5', '2026-10-24')], today).allowed).toHaveLength(1);
    expect(evaluate([advisory('GHSA-5', 'high')], [allowance('GHSA-5', '2026-10-25')], today).allowed).toHaveLength(1);
  });

  it('blocks again once the allowance has expired', () => {
    const result = evaluate([advisory('GHSA-6', 'high')], [allowance('GHSA-6', '2026-10-23')], today);
    expect(result.expired.map((a) => a.id)).toEqual(['GHSA-6']);
    expect(result.allowed).toEqual([]);
  });

  it('an allowance for one advisory does not cover another', () => {
    const result = evaluate([advisory('GHSA-7', 'high')], [allowance('GHSA-OTHER', '2027-01-01')], today);
    expect(result.blocked.map((a) => a.id)).toEqual(['GHSA-7']);
  });
});
