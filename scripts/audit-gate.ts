import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * CI gate for `npm audit --omit=dev`: fails on a high or critical advisory in production dependencies unless it is
 * listed in `audit-allowlist.json` with a reason and an expiry date. An expired allowance blocks again, so a
 * "known, not exploitable here" decision is re-made on a schedule instead of being forgotten.
 */
export interface Allowance {
  id: string;
  reason: string;
  /** `YYYY-MM-DD`: the last day the allowance counts. */
  expires: string;
}

export interface Advisory {
  id: string;
  severity: string;
  title: string;
  packageName: string;
}

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/** The advisories in an `npm audit --json` report (the objects inside each package's `via`), one per advisory id. */
export function advisoriesFrom(report: unknown): Advisory[] {
  const vulnerabilities = (report as { vulnerabilities?: Record<string, { via?: unknown[] }> }).vulnerabilities ?? {};
  const found = new Map<string, Advisory>();
  for (const vulnerability of Object.values(vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || via === null) continue;
      const { url, severity, title, name } = via as { url?: string; severity?: string; title?: string; name?: string };
      if (!url || !severity) continue;
      const id = url.split('/').pop() ?? url;
      found.set(id, { id, severity, title: title ?? '', packageName: name ?? '' });
    }
  }
  return [...found.values()];
}

export interface GateResult {
  blocked: Advisory[];
  allowed: Advisory[];
  expired: Advisory[];
}

export function evaluate(advisories: Advisory[], allowances: Allowance[], today: string): GateResult {
  const result: GateResult = { blocked: [], allowed: [], expired: [] };
  for (const advisory of advisories) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue;
    const allowance = allowances.find((a) => a.id === advisory.id);
    if (!allowance) result.blocked.push(advisory);
    else if (allowance.expires < today) result.expired.push(advisory);
    else result.allowed.push(advisory);
  }
  return result;
}

function runAudit(): unknown {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' }));
  } catch (error) {
    // npm audit exits 1 when it finds anything; the report is still on stdout.
    const stdout = (error as { stdout?: string }).stdout;
    if (!stdout) throw error;
    return JSON.parse(stdout);
  }
}

function main(): void {
  const allowances = JSON.parse(readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8')) as Allowance[];
  const today = new Date().toISOString().slice(0, 10);
  const { blocked, allowed, expired } = evaluate(advisoriesFrom(runAudit()), allowances, today);
  for (const advisory of allowed) console.log(`allowed   ${advisory.id} (${advisory.packageName}, ${advisory.severity}): ${advisory.title}`);
  for (const advisory of expired) console.log(`EXPIRED   ${advisory.id} (${advisory.packageName}, ${advisory.severity}): ${advisory.title}`);
  for (const advisory of blocked) console.log(`BLOCKED   ${advisory.id} (${advisory.packageName}, ${advisory.severity}): ${advisory.title}`);
  if (blocked.length > 0 || expired.length > 0) {
    console.log('npm audit gate: FAILED');
    process.exitCode = 1;
  } else {
    console.log('npm audit gate: passed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
