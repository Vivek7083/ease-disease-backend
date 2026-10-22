import type { Request } from 'express';

/** The database CHECKs: an address is at most 45 characters (the longest IPv6 text form), a user-agent at most 512. */
export const MAX_IP_CHARS = 45;
export const MAX_USER_AGENT_CHARS = 512;

/** Who sent a request, kept as chargeback evidence on a booking or a payment. Never returned by any endpoint. */
export interface RequestOrigin {
  ip: string | null;
  userAgent: string | null;
}

const CONTROL = /\p{Cc}/gu;
/** Express reports an IPv4 client of a dual-stack socket as `::ffff:203.0.113.5`; store the plain address. */
const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function cleanIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ip = raw.replace(CONTROL, '').trim().replace(IPV4_MAPPED, '$1');
  return ip.length >= 1 && ip.length <= MAX_IP_CHARS ? ip : null;
}

/** Control characters removed, cut to 512 characters (not bytes, the way Postgres counts), nothing left means null. */
export function cleanUserAgent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = Array.from(raw.replace(CONTROL, '').trim()).slice(0, MAX_USER_AGENT_CHARS).join('').trim();
  return text === '' ? null : text;
}

/**
 * The client address is `req.ip`, which Express resolves according to the trust-proxy setting (see trust-proxy.ts), so a
 * forged `X-Forwarded-For` cannot choose it unless the deployment says a proxy in front is trusted. The raw header is
 * never read here.
 */
export function requestOrigin(req: Pick<Request, 'ip' | 'headers'>): RequestOrigin {
  return { ip: cleanIp(req.ip), userAgent: cleanUserAgent(req.headers['user-agent']) };
}
