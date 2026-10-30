/* =============================================================================
   Roles & Permissions, ticket 27 (H5, D1): the entry points to the company's Owner, read from the source. No database.

   Who owns a company is `organizations.owner_user_id`. In the running app ONLY the Make Owner approval moves it. Every other
   place that writes it is listed below with what it may do, and a write anywhere else fails this guard, so a new way to change
   the Owner can't appear unreviewed. The routes of Make Owner itself are checked to carry their guards.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const BACKEND = path.resolve(__dirname, '..', '..');

/**
 * Every file outside tests that writes the Owner, with what it may do. The app's only move is the approval; the rest set a
 * new company's first Owner (only when it has none), clear it to delete a company, or are migrations.
 */
const OWNER_WRITERS: Record<string, string> = {
  'src/lib/users/owner-handover.ts': 'THE move: the Make Owner approval link, under the company lock, re-checking both people (ticket 27)',
  'src/lib/users/first-owner.ts': "a new company's first Owner, written only when it has none: onboarding (scripts/bootstrap-admin.ts), the seeds, the demo and e2e companies",
  'src/lib/purge.ts': 'deleting a whole company: the Owner reference is cleared first so the rows can go',
  'prisma/migrations/20261028110000_organization_owner/migration.sql': 'M11: the first Owner of every company that had none, once',
};

/** A write of the column or of the relation, in a Prisma data object or in SQL. */
const WRITE = [
  // A data or where object naming the column. Not a read: `select: { owner_user_id: true }`, a type (`owner_user_id: string`), or
  // the sign-in payload's own `org_owner_user_id` field.
  /\bowner_user_id\s*:\s*(?!\s|true\b|string\b)/,
  /\bowner\s*:\s*\{\s*(connect|disconnect|set|connectOrCreate)\b/, // the relation
  /SET\s+"?owner_user_id"?\s*=/i, // SQL
  /INSERT\s+INTO\s+"?organizations"?[^;]*owner_user_id/i, // SQL
];

/** Reads of the column that the WRITE patterns would otherwise take for a write, each with why. */
const READS_SHAPED_LIKE_WRITES: Record<string, string> = {
  'src/lib/users/access-audit.ts': "the audit row's before and after (metadata, not the column)",
};

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files(full, out);
    else if (/\.(ts|js|mjs|cjs|sql|sh)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('ticket 27: only the Make Owner approval moves the Owner', () => {
  const scanned = ['src', 'scripts', 'prisma'].flatMap((d) => files(path.join(BACKEND, d)));

  it('scans the backend source, scripts, seeds and migrations', () => {
    const rel = scanned.map((f) => path.relative(BACKEND, f));
    expect(rel).toContain('src/lib/users/owner-handover.ts');
    expect(rel).toContain('src/seed.ts');
    expect(rel).toContain('scripts/bootstrap-admin.ts');
    expect(rel).toContain('prisma/migrations/20261028110000_organization_owner/migration.sql');
  });

  it('every write of the Owner is a listed entry point', () => {
    const writers = scanned
      .filter((f) => WRITE.some((re) => re.test(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(BACKEND, f).split(path.sep).join('/'))
      .filter((rel) => !(rel in READS_SHAPED_LIKE_WRITES));
    expect(writers.sort(), 'a new place writes organizations.owner_user_id: list it here with what it may do').toEqual(Object.keys(OWNER_WRITERS).sort());
  });

  it("in the running app only the approval moves an existing Owner: the first-Owner writer can't replace one", () => {
    const first = fs.readFileSync(path.join(BACKEND, 'src/lib/users/first-owner.ts'), 'utf8');
    expect(first).toMatch(/updateMany\(\{\s*where:\s*\{\s*id:\s*organizationId,\s*owner_user_id:\s*null\s*\}/);
    const purge = fs.readFileSync(path.join(BACKEND, 'src/lib/purge.ts'), 'utf8');
    expect([...purge.matchAll(/owner_user_id\s*:\s*([^\s},]+)/g)].map((m) => m[1])).toEqual(['null']);
  });

  it('the request route is the Owner\'s alone and the approval routes are throttled, unauthenticated by design', () => {
    const users = fs.readFileSync(path.join(BACKEND, 'src/routes/user.routes.ts'), 'utf8');
    expect(users).toMatch(/router\.post\('\/:id\/make-owner',\s*requireOwner,/);
    const authRoutes = fs.readFileSync(path.join(BACKEND, 'src/routes/auth.routes.ts'), 'utf8');
    expect(authRoutes).toMatch(/router\.post\('\/owner-approval',\s*unscopedRequest,\s*authLimiter,/);
    expect(authRoutes).toMatch(/router\.post\('\/owner-approval\/approve',\s*unscopedRequest,\s*authLimiter,/);
  });
});
