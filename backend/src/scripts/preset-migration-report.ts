/**
 * The dry run and the proof check for the preset migration (Roles & Permissions, slice S01.22).
 *
 *   dry-run  previews what the migration would do: per-organization counts, how Sales' scopes map, the custom roles it
 *            translates, the grants it drops, the per-person entries it ignores. Writes nothing.
 *   proof    after the migration: counts the switch rows per organization and role, and that every person is filled.
 *            Writes nothing; exits 1 when an organization has no rows for a built-in role or a person is not filled.
 *
 * Both run in a READ-ONLY transaction that is rolled back, against the database named by --url or DATABASE_URL, and print
 * counts and ids only: never a company name, a person's name or an email. The URL itself is never printed.
 *
 * Run with: cd backend && npx tsx src/scripts/preset-migration-report.ts dry-run|proof [--url <postgres url>]
 */
import { PrismaClient } from '@prisma/client';
import {
  dryRunReport, formatDryRunReport, formatProofReport, proofReport,
} from '../lib/permissions/switches/presetMigrationReport';

async function main(): Promise<number> {
  const [command] = process.argv.slice(2);
  const flag = process.argv.indexOf('--url');
  const url = flag >= 0 ? process.argv[flag + 1] : process.env.DATABASE_URL;
  if (!url || (command !== 'dry-run' && command !== 'proof')) {
    console.error('Usage: preset-migration-report.ts dry-run|proof [--url <postgres url>]  (default: DATABASE_URL)');
    return 2;
  }
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (command === 'dry-run') {
      for (const line of formatDryRunReport(await dryRunReport(db))) console.log(line);
      return 0;
    }
    const report = await proofReport(db);
    for (const line of formatProofReport(report)) console.log(line);
    return report.ok ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { console.error('Preset migration report failed:', err instanceof Error ? err.message : err); process.exitCode = 1; },
);
