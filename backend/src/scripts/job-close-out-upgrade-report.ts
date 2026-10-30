/**
 * The dry run and the proof check for the one-time move of existing Completed jobs (Roles & Permissions, slice S06.32).
 *
 *   dry-run  previews the move: per company, how many Completed jobs go to Done and how many to Ready to close, the totals,
 *            and where the money owed was read from. Writes nothing. `--out <file>` also saves the counts as JSON.
 *   proof    after the migration: counts the jobs the upgrade moved per company and checks nothing is left Completed, no job
 *            has two upgrade entries and the Done stamps fit. `--expect <file>` compares with a saved dry run. Writes
 *            nothing; exits 1 when a check fails or a company's counts differ.
 *
 * Both run in a READ-ONLY transaction that is rolled back, over ONE connection, against the database named by --url or
 * DATABASE_URL, and print counts and company ids only: never a company name, a job number or a person. The URL itself is
 * never printed. The files written are local; nothing is ever written to the database.
 *
 * Run with: cd backend && npx tsx src/scripts/job-close-out-upgrade-report.ts dry-run|proof [--url <postgres url>]
 *           [--out <file> | --expect <file>]
 */
import { readFileSync, writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import {
  dryRunReport, formatDryRunReport, formatProofReport, proofReport, type DryRunReport,
} from '../lib/job-close-out-upgrade';

const flagValue = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

/** The URL with one connection, whatever pool size it asked for: the hosted pool allows no more. */
function singleConnection(raw: string): string {
  const u = new URL(raw);
  u.searchParams.set('connection_limit', '1');
  return u.toString();
}

async function main(): Promise<number> {
  const [command] = process.argv.slice(2);
  const url = flagValue('--url') ?? process.env.DATABASE_URL;
  if (!url || (command !== 'dry-run' && command !== 'proof')) {
    console.error('Usage: job-close-out-upgrade-report.ts dry-run|proof [--url <postgres url>] [--out <file> | --expect <file>]  (default URL: DATABASE_URL)');
    return 2;
  }
  const db = new PrismaClient({ datasources: { db: { url: singleConnection(url) } } });
  try {
    if (command === 'dry-run') {
      const report = await dryRunReport(db);
      for (const line of formatDryRunReport(report)) console.log(line);
      const out = flagValue('--out');
      if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const expectFile = flagValue('--expect');
    const expected = expectFile ? (JSON.parse(readFileSync(expectFile, 'utf8')) as DryRunReport) : undefined;
    const report = await proofReport(db, expected);
    for (const line of formatProofReport(report, Boolean(expected))) console.log(line);
    return report.ok ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { console.error('Job close-out upgrade report failed:', err instanceof Error ? err.message : err); process.exitCode = 1; },
);
