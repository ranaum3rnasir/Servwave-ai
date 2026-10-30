import { execFileSync } from 'child_process';
import path from 'path';
import { SkipFlow, type SuiteContext } from '../context';
import { assert, chargingOrgId } from '../harness';
import { databaseIsLocal } from '../policy';
import { prisma } from '../../../src/lib/prisma';

// The nightly reconcile, run by hand against the org the suite just paid into
// (`scripts/run-payment-reconcile.ts --org <id>`), AFTER every payment flow. It must write its
// summary row and must raise no finding for any charge, payment or payment intent the suite itself
// booked. Findings about older, unrelated records in the same org are not this suite's to judge.
// (The job leaves the last ten minutes for the next night, so this is a smoke check that the job
// runs against live data and does not mistake the suite's own bookings for drift.)
export async function run(ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  // Nothing booked means nothing to check: skip (a strict run fails on a skip) rather than pass vacuously.
  if (ctx.booked.length === 0) {
    throw new SkipFlow('no payment booked by this run; run it together with the payment flows');
  }
  const orgId = await chargingOrgId(ctx);
  // Nothing booked means nothing to check: skip (a strict run fails on a skip) rather than pass vacuously.
  if (!ctx.booked.some((b) => b.orgId === orgId)) {
    throw new SkipFlow('no payment booked by this run in the suite org; run it together with the payment flows');
  }
  const startedAt = new Date();
  const backendDir = path.resolve(__dirname, '../../..');
  // A run against a local database must not email the real ops address about unrelated drift.
  const env = { ...process.env, ...(databaseIsLocal(process.env.DATABASE_URL) ? { RESEND_API_KEY: '' } : {}) };
  const out = execFileSync('npx', ['tsx', 'scripts/run-payment-reconcile.ts', '--org', orgId], {
    cwd: backendDir, env, encoding: 'utf8', timeout: 5 * 60_000,
  });
  // The summary is the pretty-printed object that starts on a line of its own (other output comes first).
  const json = out.slice(out.search(/^\{\s*$/m));
  const summary = JSON.parse(json) as { orgs: { orgId: string; status: string; findings: { kind: string; ref: string; detail: string }[]; error?: string }[] };
  assert(summary.orgs.length === 1 && summary.orgs[0].orgId === orgId, `the run covered exactly the suite's org (got ${summary.orgs.length} org(s))`);
  count++;
  const org = summary.orgs[0];
  assert(org.status !== 'ERROR', `the run could read the org (got ${org.status}: ${org.error ?? ''})`);
  count++;
  const row = await prisma.paymentReconcileRun.findFirst({ where: { organization_id: orgId, started_at: { gte: startedAt } }, orderBy: { started_at: 'desc' } });
  assert(row, 'a summary row was written for the run');
  count++;

  const mine = ctx.booked.filter((b) => b.orgId === orgId);
  const ids = new Set(mine.flatMap((b) => [b.paymentId, b.chargeId, b.intentId]).filter(Boolean) as string[]);
  assert(mine.length > 0, 'the run checked at least one booking the suite made');
  count++;
  const mentioning = org.findings.filter((f) => ids.has(f.ref) || [...ids].some((id) => f.detail.includes(id)));
  assert(mentioning.length === 0, `no finding about money the suite booked (${mine.length} bookings checked; got ${JSON.stringify(mentioning)})`);
  count++;
  if (opts.verbose) console.log(`  summary ${row.id}: ${org.status}, ${org.findings.length} finding(s) about older records, ${mine.length} bookings checked`);
  return count;
}
