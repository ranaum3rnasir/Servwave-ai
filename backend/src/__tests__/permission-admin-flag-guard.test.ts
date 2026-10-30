/* =============================================================================
   Roles & Permissions alignment, AL-03 (P15): Admin is a flag on the person, never a role name.

   A guard over the source: no non-test file decides "is this an admin" from the role name. The one question is
   `isSuperUser` (it reads `is_admin`), and every query that means "the admins" filters on the flag. The allowlist is
   the places that name the ADMIN role for a reason other than deciding who is an Admin, each with that reason; adding
   to it is a decision to be made in review, not a way to make this test pass.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * Ways to decide "admin" from the role name: a comparison, the enum member, a role list holding it, a where on it, and a
 * filter clause that is nothing but the role (`{ role: 'ADMIN' }`, as in an OR list of "who may be picked").
 */
const ROLE_NAME_ADMIN_TESTS: RegExp[] = [
  /\brole\s*(===|!==|==|!=)\s*['"]ADMIN['"]/,
  /['"]ADMIN['"]\s*(===|!==)\s*[\w.?]*role\b/,
  /\bRole\.ADMIN\b/,
  /\brole:\s*\{\s*in:\s*\[[^\]]*['"]ADMIN['"]/,
  /\bwhere:\s*\{[^}]*\brole:\s*['"]ADMIN['"]/,
  /\{\s*role:\s*['"]ADMIN['"]\s*\}/,
];

/** file (relative to backend) -> why it may still name the ADMIN role. */
// Ticket 26: the user changes no longer name the role either. Whether a role makes its holder an Admin is the role's own
// Admin flag (effectiveRole.ts, ROLE_ADMIN_FLAG), so user.controller.ts is off this list and a role-name check there fails here.
const ALLOWED: Record<string, string> = {
  'src/services/automations/recipients.ts': 'the word in a skip message ("No active admins to notify"), not a query',
  'scripts/bootstrap-admin.ts': 'one-off provisioning of a company\'s first Admin: writes role and flag together',
};

describe('Admin is a flag on the person (guard)', () => {
  // Ticket 21: staging's watcher pool (lib/permissions/watcherPool.ts) found "every admin" through a bare `{ role: 'ADMIN' }`
  // clause in an OR list, a shape the guard did not see, so a merge could bring it back unnoticed. Each line below is a real
  // role-name Admin decision taken from staging's code before it moved to the flag.
  it.each([
    ["the watcher pool's OR clause", "    { role: 'ADMIN' },"],
    ["the watcher pool's clause type", "  | { role: 'ADMIN' }"],
    ["Spider's Admin fallback", "    where: { organization_id: orgId, ...CAN_SIGN_IN, role: 'ADMIN' },"],
    ["the reconciler's refund actor", "    where: { organization_id: organizationId, role: 'ADMIN' },"],
  ])('recognises %s as deciding Admin from the role name', (_label, line) => {
    expect(ROLE_NAME_ADMIN_TESTS.some((re) => re.test(line))).toBe(true);
  });

  it('has no non-test source that decides Admin from the role name', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]) {
      const rel = relative(ROOT, file);
      if (ALLOWED[rel]) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (ROLE_NAME_ADMIN_TESTS.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}: ${code}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlisted file in use: an entry whose file no longer matches is removed', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      expect(ROLE_NAME_ADMIN_TESTS.some((re) => text.split('\n').some((l) => re.test(l))), rel).toBe(true);
    }
  });
});
