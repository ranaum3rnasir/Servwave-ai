/**
 * The permission drift checker: compares every organization's STORED built-in role sets (permission_role_switches) with the
 * catalog presets (Roles & Permissions, slice S01.22). It replaces the old check of role_permissions rows against
 * DEFAULT_GRANTS, which no longer decides anyone's access.
 *
 * Read-only (a read-only transaction, rolled back). Prints counts and ids only, never a name, and never the URL. A built-in
 * role row the store does not hold is not drift: the role resolves to the preset for it. Drift is a stored value that
 * differs from the preset, which is what an admin's edit to a built-in role looks like too, so it is reported, not hidden.
 *
 * --strict (or DRIFT_STRICT=1) exits 1 when any drift or any row for a switch the catalog no longer holds is found.
 * Without it the exit code is always 0 so manual use is unaffected.
 *
 * Run with: cd backend && npx tsx src/scripts/check-role-permission-drift.ts [--strict] [--url <postgres url>]
 */
import { PrismaClient } from '@prisma/client';
import { driftReport, formatDriftReport } from '../lib/permissions/switches/presetMigrationReport';

async function main(): Promise<number> {
  const strict = process.argv.includes('--strict') || process.env.DRIFT_STRICT === '1';
  const flag = process.argv.indexOf('--url');
  const url = flag >= 0 ? process.argv[flag + 1] : process.env.DATABASE_URL;
  if (!url) {
    console.error('Usage: check-role-permission-drift.ts [--strict] [--url <postgres url>]  (default: DATABASE_URL)');
    return 2;
  }
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const report = await driftReport(db);
    for (const line of formatDriftReport(report)) console.log(line);
    const drift = report.drifted.length + report.unknownSwitches.length;
    if (strict && drift > 0) {
      console.log(`\n::error::${drift} permission drift finding(s) - see the organization, role and switch lines above.`);
      return 1;
    }
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { console.error('Drift check failed:', err instanceof Error ? err.message : err); process.exitCode = 1; },
);
