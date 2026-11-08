#!/usr/bin/env tsx
/**
 * Repair pass for forwarded-answer attribution.
 *
 *   npm run ctm:reattribute -- --org=<uuid> [--dry-run]
 *
 * WHY THIS EXISTS
 *
 * ingestCall decides who answered ONCE, when the `end` webhook lands, and it
 * fails open: if CTM is unreachable at that moment the receiving-number lookup
 * misses, the call is recorded with no answerer, and nothing ever revisits it.
 * The information needed to name that call is still sitting in CTM - the row
 * is unattributed only because of a bad minute months ago. Failing open is the
 * right call for a webhook (rejecting it would cost the call record itself,
 * not just the name), but it is only honest if something eventually pays the
 * debt back. This is that something.
 *
 * It repairs the ordinary case too, which is the more common one: a receiving
 * number that gets named in CTM, or a user whose phone finally gets filled in,
 * retroactively explains calls that are already on file.
 *
 * The resolution itself is NOT reimplemented here - it calls the same two
 * resolvers live ingest uses, in the same order: observe who picked up from
 * the receiving-number roster, and failing that fall back to whoever the
 * dialed number is assigned to. A second copy of "how do we decide who
 * answered" would drift, and a repair pass that disagrees with live ingest is
 * worse than none.
 *
 * Safe to re-run: a row that still cannot be resolved is left untouched rather
 * than rewritten with identical content.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { resolveExternalAnswerer, resolveAssignedAnswerer } from '../src/lib/ctm/ingest';
import { warmReceivingNumbers } from '../src/lib/ctm/receivingNumbers';
import { prisma } from '../src/lib/prisma';
import { runWithOrg } from '../src/lib/tenant-context';

export const BATCH_SIZE = 200;

export interface ReattributeCounters {
  scanned: number;
  updated: number;
  unchanged: number;
  errors: number;
}

export interface ReattributeOpts {
  orgId: string;
  dryRun?: boolean;
}

/** Injected in tests; defaults to the real modules for a live run. */
export interface ReattributeDeps {
  prisma: PrismaClient;
  resolveExternalAnswerer: typeof resolveExternalAnswerer;
  resolveAssignedAnswerer: typeof resolveAssignedAnswerer;
  warmReceivingNumbers: typeof warmReceivingNumbers;
}

export function defaultDeps(): ReattributeDeps {
  return {
    prisma: prisma as unknown as PrismaClient,
    resolveExternalAnswerer,
    resolveAssignedAnswerer,
    warmReceivingNumbers,
  };
}

export async function reattributeOrg(
  deps: ReattributeDeps,
  opts: ReattributeOpts,
): Promise<ReattributeCounters> {
  const counters: ReattributeCounters = { scanned: 0, updated: 0, unchanged: 0, errors: 0 };

  // The ENTIRE run is scoped to the target org so every query passes the RLS
  // tenant guard (fail-closed without a context).
  await runWithOrg(opts.orgId, async () => {
    const org = await deps.prisma.organization.findUnique({
      where: { id: opts.orgId },
      select: { id: true, ctm_account_id: true },
    });
    if (!org) {
      throw new Error(`Organization ${opts.orgId} not found`);
    }
    if (!org.ctm_account_id) {
      throw new Error(`Organization ${opts.orgId} is not connected to CTM (ctm_account_id is empty)`);
    }
    const accountId = org.ctm_account_id;

    // Once, up front: the resolver reads this cache synchronously and never
    // fetches on its own.
    await deps.warmReceivingNumbers(accountId);

    let cursor: string | undefined;
    for (;;) {
      const batch = await deps.prisma.callSession.findMany({
        where: {
          organization_id: opts.orgId,
          agent_id: null,
          answered_by: { path: ['kind'], equals: 'external' },
        },
        // to_number is the number the caller dialed - the org's own tracking
        // number on an inbound call, and the key the assignment fallback needs.
        select: { id: true, answered_by: true, to_number: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        // Cursor, not offset: repairing a row drops it out of the filtered set,
        // so `skip` would step straight over the rows that moved up to fill the
        // gap. Re-fetching the first N would not terminate either, because the
        // genuinely unresolvable rows never leave the set.
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.id;

      for (const row of batch) {
        counters.scanned += 1;
        try {
          // Same order as live ingest: the observed answerer first, the
          // number's assignee only when nothing was observed.
          const resolved =
            (await deps.resolveExternalAnswerer(
              deps.prisma,
              opts.orgId,
              row.answered_by as Prisma.InputJsonObject,
              accountId,
            )) ??
            (row.to_number
              ? await deps.resolveAssignedAnswerer(deps.prisma, opts.orgId, row.to_number)
              : null);
          if (!resolved) {
            counters.unchanged += 1;
            continue;
          }
          counters.updated += 1;
          if (opts.dryRun) continue;
          await deps.prisma.callSession.update({
            where: { id: row.id },
            data: { agent_id: resolved.agentId, answered_by: resolved.answeredBy },
          });
        } catch (err) {
          // One bad row never aborts the run: a pass that stops halfway leaves
          // the operator unsure how far it got.
          counters.errors += 1;
          console.error(
            `  ! call ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (batch.length < BATCH_SIZE) break;
    }
  });

  return counters;
}

// ─── CLI shell ───────────────────────────────────────────────────────────────

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgId = argValue(args, '--org');
  const dryRun = args.includes('--dry-run');

  if (!orgId) {
    console.error('Usage: npm run ctm:reattribute -- --org=<uuid> [--dry-run]');
    process.exit(1);
  }

  console.log(`CTM forwarded-answer repair - org=${orgId}${dryRun ? ' (dry-run)' : ''}`);

  const counters = await reattributeOrg(defaultDeps(), { orgId, dryRun });

  console.log(`\nRepair ${dryRun ? 'dry-run ' : ''}complete:`);
  console.log(`  scanned:   ${counters.scanned}`);
  console.log(`  ${dryRun ? 'would update:' : 'updated:'}     ${counters.updated}`);
  console.log(`  unchanged: ${counters.unchanged}`);
  console.log(`  errors:    ${counters.errors}`);
}

// Only run when executed directly (not when imported by tests).
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Repair failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
