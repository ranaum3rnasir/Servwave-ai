/**
 * The dry run and the proof check for the one-time issue of a mailbox to every active user (Roles & Permissions, PRD 10,
 * slice S10.3). It reads the migration's own plan, so it can be run against any environment's database before the
 * migration runs there, and again afterwards.
 *
 *   dry-run  previews the issue: the user mailboxes that already exist by state, per company, how many active users get a
 *            first.last.company address and how many land in "address needed" (and why), the totals, and the namesake
 *            groups by user id (the user who gets the address -> the users who do not). It then evaluates EVERY condition
 *            the migration stops on against the end state the plan would leave, printing PASS or FAIL for each with the
 *            ids (mailbox, user, company) of what would trip it, and EXITS 1 when any would fail. On a database that
 *            already has the migration it says "already applied: nothing to do" and exits 0. Writes nothing.
 *            `--out <file>` also saves the report, ids included, as JSON.
 *   proof    after the migration: counts the live user mailboxes per company, evaluates the same stop conditions on the
 *            written state, and checks none has two, every address fits its mailbox's status and no address is shared.
 *            `--expect <file>` compares with a saved dry run. Writes nothing; exits 1 when a check fails or a company's
 *            counts differ.
 *
 * Both run in a READ-ONLY transaction that is rolled back, over ONE connection, against the database named by --url or
 * DATABASE_URL, and print counts, company ids and user ids only: never a company or person name, never an address. The
 * URL itself is never printed. The files written are local; nothing is ever written to the database.
 *
 * Run with: cd backend && npx tsx src/scripts/user-mailbox-report.ts dry-run|proof [--url <postgres url>]
 *           [--out <file> | --expect <file>]   (npm run mailboxes:user-dry-run, npm run mailboxes:user-proof)
 */
import { readFileSync, writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import {
  dryRunExitCode, dryRunReport, formatDryRunReport, formatProofReport, proofReport, type DryRunReport,
} from '../lib/mailbox/user-mailbox-report';

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
    console.error('Usage: user-mailbox-report.ts dry-run|proof [--url <postgres url>] [--out <file> | --expect <file>]  (default URL: DATABASE_URL)');
    return 2;
  }
  const db = new PrismaClient({ datasources: { db: { url: singleConnection(url) } } });
  try {
    if (command === 'dry-run') {
      const report = await dryRunReport(db);
      for (const line of formatDryRunReport(report)) console.log(line);
      const out = flagValue('--out');
      if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      return dryRunExitCode(report);
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
  (err) => { console.error('User mailbox report failed:', err instanceof Error ? err.message : err); process.exitCode = 1; },
);
