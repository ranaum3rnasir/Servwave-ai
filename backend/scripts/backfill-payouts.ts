#!/usr/bin/env npx tsx
/**
 * Backfill ServWave's payout records (payments go-live slice P2).
 *
 * Usage:
 *   npx tsx scripts/backfill-payouts.ts --org <id> [--org <id>] [--days 120] [--dry-run]
 *   npx tsx scripts/backfill-payouts.ts --all [--days 120] [--dry-run]
 *
 * Per org with a connected account: lists its payouts for the last N days (default 120), upserts them
 * and links the payments whose balance transaction is in each. Refuses to run without an explicit org
 * list or --all. --dry-run lists and prints counts only; nothing is written. Idempotent: running it
 * twice changes nothing. Prints the summary as JSON.
 * Uses the DATABASE_URL and STRIPE_SECRET_KEY of the environment it runs in.
 */
import { prisma } from '../src/lib/prisma';
import { runUnscoped, runWithOrg } from '../src/lib/tenant-context';
import { syncOrgPayouts, type OrgPayoutSyncResult } from '../src/lib/payout-sync';

const DEFAULT_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackfillArgs {
  orgIds: string[] | 'all';
  dryRun: boolean;
  days: number;
}

export function parseBackfillArgs(argv: string[]): ({ ok: true } & BackfillArgs) | { ok: false; error: string } {
  const orgIds: string[] = [];
  argv.forEach((a, i) => { if (a === '--org' && argv[i + 1]) orgIds.push(argv[i + 1]); });
  const all = argv.includes('--all');
  if (!all && orgIds.length === 0) return { ok: false, error: 'name the orgs with --org <id> (repeatable), or pass --all' };
  let days = DEFAULT_DAYS;
  const at = argv.indexOf('--days');
  if (at >= 0) {
    days = Number(argv[at + 1]);
    if (!Number.isInteger(days) || days <= 0) return { ok: false, error: '--days needs a positive whole number' };
  }
  return { ok: true, orgIds: all ? 'all' : orgIds, dryRun: argv.includes('--dry-run'), days };
}

export type OrgBackfillResult = ({ orgId: string } & OrgPayoutSyncResult) | { orgId: string; error: string };

export async function runBackfill(args: BackfillArgs, now: Date = new Date()): Promise<{ dryRun: boolean; days: number; orgs: OrgBackfillResult[] }> {
  const sinceUnix = Math.floor((now.getTime() - args.days * DAY_MS) / 1000);
  const rows = await runUnscoped(() => prisma.organization.findMany({
    where: { stripe_account_id: { not: null }, ...(args.orgIds === 'all' ? {} : { id: { in: args.orgIds } }) },
    select: { id: true, stripe_account_id: true },
    orderBy: { id: 'asc' },
  }));
  const orgs: OrgBackfillResult[] = [];
  if (args.orgIds !== 'all') {
    const have = new Set(rows.map((r) => r.id));
    for (const id of args.orgIds) if (!have.has(id)) orgs.push({ orgId: id, error: `no such org with a payout account: ${id}` });
  }
  for (const row of rows) {
    try {
      const result = await runWithOrg(row.id, () => syncOrgPayouts(row.id, row.stripe_account_id!, sinceUnix, { dryRun: args.dryRun }));
      orgs.push({ orgId: row.id, ...result });
    } catch (err) {
      orgs.push({ orgId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { dryRun: args.dryRun, days: args.days, orgs };
}

async function main() {
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  const summary = await runBackfill(parsed);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.orgs.some((o) => 'error' in o)) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
