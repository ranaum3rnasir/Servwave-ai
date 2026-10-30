/**
 * Roles & Permissions alignment, AL-03 (P15): Admin is a flag on the person, never a role name. No screen decides
 * "is this an admin" from `role`: it asks `is_admin` (or the ability, for what a person may do).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const TESTS: RegExp[] = [
  /\brole\s*(===|!==|==|!=)\s*['"]ADMIN['"]/,
  /\brole\??\.\s*includes/, // never a list of role names
  /allowedRoles=\{\[\s*['"]ADMIN['"]\s*\]\}/,
];

describe('Admin is a flag on the person (guard)', () => {
  it('has no screen or hook that decides Admin from the role name', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (TESTS.some((re) => re.test(line))) offenders.push(`${relative(SRC, file)}:${i + 1}: ${code}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
