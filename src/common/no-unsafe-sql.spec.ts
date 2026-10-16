import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard rail: application code must only talk to the database through Prisma's parameterised API
 * (`create`, `updateMany`, ... or the tagged template `$queryRaw\`... ${value}\``), so user input is always
 * bound as data. These patterns are the ways to build SQL from strings, and none may appear in `src/`.
 * (Test helpers under `test/` may use them on constants; they are not scanned.)
 */
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: '$queryRawUnsafe / $executeRawUnsafe', pattern: /\$(query|execute)Raw(Unsafe)?\s*\(/ },
  { name: 'Prisma.raw(...)', pattern: /\bPrisma\.raw\s*\(/ },
  { name: 'Prisma.sql.raw / sql.raw(...)', pattern: /\bsql\.raw\s*\(/ },
  { name: 'Prisma.sql(...) called as a function with a string', pattern: /\bPrisma\.sql\s*\(\s*['"`]/ },
];

export function findUnsafeSql(source: string): { name: string; line: number }[] {
  const findings: { name: string; line: number }[] = [];
  source.split('\n').forEach((text, index) => {
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) findings.push({ name, line: index + 1 });
    }
  });
  return findings;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === 'generated' ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('no string-built SQL in src/', () => {
  it('finds none in the application code', () => {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const offenders = sourceFiles(srcDir).flatMap((file) =>
      findUnsafeSql(readFileSync(file, 'utf8')).map((f) => `${relative(srcDir, file)}:${f.line} uses ${f.name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('scans a meaningful number of files (the scan itself is not silently empty)', () => {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const files = sourceFiles(srcDir).map((f) => relative(srcDir, f).replaceAll('\\', '/'));
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain('payments/payment-handler.service.ts');
    expect(files.some((f) => f.startsWith('generated/'))).toBe(false);
  });

  describe('the detector itself', () => {
    it.each([
      'await this.prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);',
      'await prisma.$executeRawUnsafe("DELETE FROM x WHERE a = \'" + a + "\'");',
      'await prisma.$queryRaw(Prisma.sql`SELECT 1`);',
      'const q = Prisma.raw(userInput);',
      'const q = sql.raw(userInput);',
      "await prisma.$executeRaw('UPDATE x SET a = ' + a);",
    ])('flags: %s', (line) => {
      expect(findUnsafeSql(line).length).toBeGreaterThan(0);
    });

    it.each([
      'await this.prisma.$queryRaw`SELECT 1 AS ok`;',
      'await prisma.$executeRaw`UPDATE bookings SET status = ${status}::booking_status WHERE id = ${id}::uuid`;',
      'await tx.booking.updateMany({ where: { id }, data: { status: "CONFIRMED" } });',
      '// we never call $queryRawUnsafe here',
    ])('allows: %s', (line) => {
      // The comment line mentions the name without a call, so it has no "(" after it.
      expect(findUnsafeSql(line)).toEqual([]);
    });

    it('reports the right line number', () => {
      expect(findUnsafeSql('a\nb\nprisma.$executeRawUnsafe(x)\nd')).toEqual([
        { name: '$queryRawUnsafe / $executeRawUnsafe', line: 3 },
      ]);
    });
  });
});
