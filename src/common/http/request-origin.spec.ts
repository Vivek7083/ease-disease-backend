import { describe, expect, it } from 'vitest';
import { MAX_USER_AGENT_CHARS, cleanIp, cleanUserAgent, requestOrigin } from './request-origin.js';

describe('cleanIp', () => {
  it.each([
    ['203.0.113.5', '203.0.113.5'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['::FFFF:10.0.0.1', '10.0.0.1'],
    ['2001:db8::8a2e:370:7334', '2001:db8::8a2e:370:7334'],
    ['::1', '::1'],
    [' 203.0.113.5 ', '203.0.113.5'],
    ['203.0.113.\u00005', '203.0.113.5'],
  ])('keeps %j as %j', (raw, expected) => {
    expect(cleanIp(raw)).toBe(expected);
  });

  it('accepts the longest IPv6 text form (45 characters) and refuses 46', () => {
    expect(cleanIp('x'.repeat(45))).toHaveLength(45);
    expect(cleanIp('x'.repeat(46))).toBeNull();
  });

  it.each([undefined, null, '', '   ', 42, {}, ['1.2.3.4']])('gives null for %j', (raw) => {
    expect(cleanIp(raw)).toBeNull();
  });
});

describe('cleanUserAgent', () => {
  it('keeps an ordinary browser string', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    expect(cleanUserAgent(ua)).toBe(ua);
  });

  it('cuts at 512 characters, counting characters not bytes, and never leaves a trailing space', () => {
    expect(cleanUserAgent('a'.repeat(512))).toHaveLength(512);
    expect(cleanUserAgent('a'.repeat(513))).toHaveLength(512);
    expect(Array.from(cleanUserAgent('é'.repeat(600))!)).toHaveLength(MAX_USER_AGENT_CHARS);
    expect(Array.from(cleanUserAgent('🙂'.repeat(600))!)).toHaveLength(MAX_USER_AGENT_CHARS);
    expect(cleanUserAgent(`${'a'.repeat(511)} b`)).toBe('a'.repeat(511));
  });

  it('removes control characters (log-forging, NUL which Postgres refuses)', () => {
    expect(cleanUserAgent('Agent\u0000/1.0\r\nX-Evil: 1\u001b')).toBe('Agent/1.0X-Evil: 1');
  });

  it.each([undefined, null, '', '   ', '\u0000\u0001', 42, ['a'], {}])('gives null for %j', (raw) => {
    expect(cleanUserAgent(raw)).toBeNull();
  });
});

describe('requestOrigin', () => {
  it('reads req.ip and the user-agent header, never X-Forwarded-For', () => {
    const req = { ip: '203.0.113.5', headers: { 'user-agent': 'Agent/1.0', 'x-forwarded-for': '198.51.100.9' } };
    expect(requestOrigin(req)).toEqual({ ip: '203.0.113.5', userAgent: 'Agent/1.0' });
  });

  it('missing values are null', () => {
    expect(requestOrigin({ ip: undefined, headers: {} })).toEqual({ ip: null, userAgent: null });
  });
});
