#!/usr/bin/env tsx
/**
 * One-time fill-in of the company number on texts stored before texts recorded it (Roles &
 * Permissions S08.1). Run by hand, once per environment, straight after the migration that adds
 * `messages.phone_number_id`. It is never scheduled and nothing after the release depends on it:
 * every new text stores its own company number.
 *
 * Two sources, in this order, per organization:
 *   1. The phone service's history (calls AND texts share one list, the same re-read
 *      scripts/ctm-backfill.ts uses). A stored text is matched by the phone service's message id and
 *      takes the tracking number the history names.
 *   2. For app-sent texts the history did not place, the "text sent" audit entry: it recorded the
 *      phone-service id of the number the text left from, which maps to the organization's number.
 * Only texts that have NO company number yet are written, so a second run changes nothing. Texts
 * neither source can place stay without a number. The sender of older app-sent texts stays empty:
 * no record of it exists.
 *
 * ALL work runs inside runWithOrg(orgId) (see ctm-backfill.ts for why).
 *
 * Usage:
 *   npm run texts:fill-company-numbers                  every organization
 *   npm run texts:fill-company-numbers -- --org=<uuid>  one organization
 *
 * Prints the row counts per source. Exit code 0 = completed, 1 = the run failed.
 */
import type { PrismaClient } from '@prisma/client';
import { listCalls } from '../src/lib/ctm/client';
import { unwrapActivity } from '../src/lib/ctm/ingest';
import { resolveCompanyNumberId } from '../src/lib/ctm/companyNumber';
import { prisma } from '../src/lib/prisma';
import { runUnscoped, runWithOrg } from '../src/lib/tenant-context';
import { isSmsActivity } from './ctm-backfill';

const AUDIT_BATCH = 500;
// Batches walk the ids upward; every real id sorts above the all-zero one.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface FillInCounts {
  texts_matched_history: number;
  texts_matched_audit: number;
  texts_left_without_number: number;
}

export interface FillInDeps {
  client: { listCalls: typeof listCalls };
  prisma: PrismaClient;
}

export function defaultDeps(): FillInDeps {
  return { client: { listCalls }, prisma: prisma as unknown as PrismaClient };
}

async function fillFromHistory(deps: FillInDeps, orgId: string, accountId: string): Promise<number> {
  const numberIds = new Map<string, string | null>();
  let matched = 0;
  for await (const page of deps.client.listCalls(accountId)) {
    for (const item of page) {
      const a = unwrapActivity(item);
      if (!isSmsActivity(a)) continue;
      const messageId = String(a.message_id ?? '');
      if (!messageId) continue;

      const tracking = String(a.tracking_number ?? '');
      if (!numberIds.has(tracking)) {
        numberIds.set(tracking, await resolveCompanyNumberId(deps.prisma, orgId, tracking));
      }
      const numberId = numberIds.get(tracking);
      if (!numberId) continue;

      const { count } = await deps.prisma.message.updateMany({
        where: { organization_id: orgId, ctm_sms_id: messageId, phone_number_id: null },
        data: { phone_number_id: numberId },
      });
      matched += count;
    }
  }
  return matched;
}

async function fillFromAuditTrail(deps: FillInDeps, orgId: string): Promise<number> {
  const numbers = await deps.prisma.phoneNumber.findMany({
    where: { organization_id: orgId, ctm_number_id: { not: null } },
    select: { id: true, ctm_number_id: true },
  });
  const byProviderId = new Map(numbers.map((n) => [n.ctm_number_id as string, n.id]));

  let matched = 0;
  let lastId = NIL_UUID;
  for (;;) {
    const batch = await deps.prisma.message.findMany({
      where: { organization_id: orgId, direction: 'out', phone_number_id: null, id: { gt: lastId } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: AUDIT_BATCH,
    });
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;

    const entries = await deps.prisma.auditLog.findMany({
      where: {
        org_id: orgId,
        action: 'sms.sent',
        resource_type: 'Message',
        resource_id: { in: batch.map((m) => m.id) },
      },
      select: { resource_id: true, metadata: true },
    });
    for (const entry of entries) {
      const meta = entry.metadata as { from_tpn?: unknown } | null;
      const numberId = typeof meta?.from_tpn === 'string' ? byProviderId.get(meta.from_tpn) : undefined;
      if (!numberId || !entry.resource_id) continue;
      const { count } = await deps.prisma.message.updateMany({
        where: { id: entry.resource_id, organization_id: orgId, phone_number_id: null },
        data: { phone_number_id: numberId },
      });
      matched += count;
    }
  }
  return matched;
}

/** Fill in one organization's texts. `accountId` is read from the organization unless given. */
export async function fillInOrg(
  deps: FillInDeps,
  opts: { orgId: string; accountId?: string | null },
): Promise<FillInCounts> {
  return runWithOrg(opts.orgId, async () => {
    const accountId =
      opts.accountId !== undefined
        ? opts.accountId
        : (
            await deps.prisma.organization.findUnique({
              where: { id: opts.orgId },
              select: { ctm_account_id: true },
            })
          )?.ctm_account_id ?? null;

    const texts_matched_history = accountId ? await fillFromHistory(deps, opts.orgId, accountId) : 0;
    const texts_matched_audit = await fillFromAuditTrail(deps, opts.orgId);
    const texts_left_without_number = await deps.prisma.message.count({
      where: { organization_id: opts.orgId, phone_number_id: null },
    });
    return { texts_matched_history, texts_matched_audit, texts_left_without_number };
  });
}

/** Fill in every organization and sum the counts. */
export async function fillInAllOrgs(deps: FillInDeps): Promise<FillInCounts> {
  const orgs = await runUnscoped(() =>
    deps.prisma.organization.findMany({ select: { id: true, ctm_account_id: true } }),
  );
  const totals: FillInCounts = { texts_matched_history: 0, texts_matched_audit: 0, texts_left_without_number: 0 };
  for (const org of orgs) {
    const counts = await fillInOrg(deps, { orgId: org.id, accountId: org.ctm_account_id });
    totals.texts_matched_history += counts.texts_matched_history;
    totals.texts_matched_audit += counts.texts_matched_audit;
    totals.texts_left_without_number += counts.texts_left_without_number;
  }
  return totals;
}

// ─── CLI shell ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const orgArg = process.argv.slice(2).find((a) => a.startsWith('--org='));
  const orgId = orgArg ? orgArg.slice('--org='.length) : undefined;

  console.log(`Text company-number fill-in${orgId ? ` - org=${orgId}` : ' - every organization'}`);
  const deps = defaultDeps();
  const counts = orgId ? await fillInOrg(deps, { orgId }) : await fillInAllOrgs(deps);

  console.log('\nFill-in complete:');
  console.log(`  texts matched through the history:     ${counts.texts_matched_history}`);
  console.log(`  texts matched through the audit trail: ${counts.texts_matched_audit}`);
  console.log(`  texts left without a number:           ${counts.texts_left_without_number}`);
}

// Only run when executed directly (not when imported by tests).
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fill-in failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
