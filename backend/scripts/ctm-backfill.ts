#!/usr/bin/env tsx
/**
 * CTM historical backfill — one-off script (master plan §4 scripts row, §6 row 9).
 *
 * Pulls an org's CTM activity history (calls AND texts share the /calls list)
 * page-by-page and re-ingests it through the SAME lib the webhook uses — the
 * upserts are idempotent, so re-running dedupes against live-ingested rows —
 * and re-attempts recordings that never landed (recording_key still null).
 *
 * ALL work runs inside runWithOrg(orgId): with DB_TENANT_GUARD=on a standalone
 * script has no request context, so every query would otherwise fail CLOSED
 * (zero rows). Items are paced (sleep 120ms, same budget as the client's
 * request spacing) so a long backfill can't trip CTM's agency-wide throttle.
 *
 * Usage (precedent: scripts/verify-stripe.ts):
 *   npm run ctm:backfill -- --org=<uuid> [--dry-run] [--since=YYYY-MM-DD]
 *
 *   --org      required — the ServWave organization id to backfill
 *   --dry-run  classify + count only; ZERO ingest/write calls
 *   --since    only activities from this date on (CTM `start_date` param)
 *
 * Exit codes: 0 = run completed (per-item errors are counted, not fatal);
 * 1 = the whole run failed (bad args, org missing/unconnected, page fetch died).
 */
import type { PrismaClient } from '@prisma/client';
import { listCalls } from '../src/lib/ctm/client';
import { ingestCall, ingestSms, unwrapActivity } from '../src/lib/ctm/ingest';
import { ingestRecording } from '../src/lib/ctm/recordings';
import { warmReceivingNumbers } from '../src/lib/ctm/receivingNumbers';
import { prisma } from '../src/lib/prisma';
import { runWithOrg } from '../src/lib/tenant-context';

// Matches client.ts MIN_REQUEST_INTERVAL_MS / plan §4 "sleep(120)" pacing.
const PACING_MS = 120;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface BackfillCounters {
  calls: number;
  sms: number;
  recordings_fetched: number;
  skipped: number;
  errors: number;
}

export interface BackfillOpts {
  orgId: string;
  dryRun?: boolean;
  /** YYYY-MM-DD → forwarded as the CTM `start_date` list param. */
  since?: string;
}

/** Injected in tests; defaults to the real modules for a live run. */
export interface BackfillDeps {
  client: { listCalls: typeof listCalls };
  ingestCall: typeof ingestCall;
  ingestSms: typeof ingestSms;
  ingestRecording: typeof ingestRecording;
  prisma: PrismaClient;
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(): BackfillDeps {
  return {
    client: { listCalls },
    ingestCall,
    ingestSms,
    ingestRecording,
    prisma: prisma as unknown as PrismaClient,
    sleep: realSleep,
  };
}

// Texts ride the same /calls list as calls. A text is recognized by a msg_*
// direction (msg_inbound/msg_outbound) OR an MSG…-prefixed message id.
function isSmsActivity(a: Record<string, unknown>): boolean {
  if (String(a.direction ?? '').toLowerCase().startsWith('msg_')) return true;
  return String(a.message_id ?? '').toUpperCase().startsWith('MSG');
}

async function processItem(
  deps: BackfillDeps,
  opts: BackfillOpts,
  counters: BackfillCounters,
  accountId: string,
  item: Record<string, unknown>,
): Promise<void> {
  const a = unwrapActivity(item);

  if (isSmsActivity(a)) {
    if (opts.dryRun) {
      counters.sms += 1;
      return;
    }
    const res = await deps.ingestSms(deps.prisma, opts.orgId, item, { suppressNotifications: true });
    if (res) counters.sms += 1;
    else counters.skipped += 1;
    return;
  }

  if (opts.dryRun) {
    counters.calls += 1;
    return;
  }
  // Historical rows are final — ingest at position 'end' so status/duration/
  // recording fields are written (a 'starts' would only create ringing shells).
  // suppressNotifications: a historical import must not ring bells or flood
  // threads with unread counts — only live webhook traffic notifies.
  // A historical call answered on a forwarded phone carries only a
  // receiving_number_id; ingest resolves it against CTM's roster, which has to
  // be in the cache first. Warming per item costs one request per TTL window
  // and, unlike a single warm before the loop, survives a run that outlasts it.
  await warmReceivingNumbers(accountId);
  const res = await deps.ingestCall(deps.prisma, opts.orgId, item, 'end', {
    suppressNotifications: true,
    ctmAccountId: accountId,
  });
  if (!res) {
    counters.skipped += 1;
    return;
  }
  counters.calls += 1;

  // Recording re-attempt: only when CTM says one exists AND we never stored it
  // (recording_key null — the live webhook fetch may have failed terminally).
  if (!res.hasRecording) return;
  const row = await deps.prisma.callSession.findUnique({
    where: { id: res.callSessionId },
    select: { recording_key: true },
  });
  if (row?.recording_key) {
    counters.skipped += 1; // already keyed — never re-download
    return;
  }
  // ingestRecording never throws (recordings.ts failure contract).
  await deps.ingestRecording({
    orgId: opts.orgId,
    callSessionId: res.callSessionId,
    ctmAccountId: accountId,
    callSid: res.sid,
  });
  counters.recordings_fetched += 1;
}

export async function backfillOrg(deps: BackfillDeps, opts: BackfillOpts): Promise<BackfillCounters> {
  const counters: BackfillCounters = { calls: 0, sms: 0, recordings_fetched: 0, skipped: 0, errors: 0 };

  // The ENTIRE run — org load included — is scoped to the target org so every
  // query passes the RLS tenant guard (fail-closed without a context).
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

    const params: Record<string, string | number | undefined> = {};
    if (opts.since) params.start_date = opts.since;

    for await (const page of deps.client.listCalls(accountId, params)) {
      for (const item of page) {
        try {
          await processItem(deps, opts, counters, accountId, item);
        } catch (err) {
          // One bad item never aborts the run — count it and keep going.
          counters.errors += 1;
          console.error(`  ! item failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await deps.sleep(PACING_MS);
      }
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
  const since = argValue(args, '--since');
  const dryRun = args.includes('--dry-run');

  if (!orgId) {
    console.error('Usage: npm run ctm:backfill -- --org=<uuid> [--dry-run] [--since=YYYY-MM-DD]');
    process.exit(1);
  }
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('--since must be YYYY-MM-DD');
    process.exit(1);
  }

  console.log(
    `CTM historical backfill — org=${orgId}${dryRun ? ' (dry-run)' : ''}${since ? ` since=${since}` : ''}`,
  );

  const counters = await backfillOrg(defaultDeps(), { orgId, dryRun, since });

  console.log(`\nBackfill ${dryRun ? 'dry-run ' : ''}complete:`);
  console.log(`  calls:              ${counters.calls}`);
  console.log(`  sms:                ${counters.sms}`);
  console.log(`  recordings_fetched: ${counters.recordings_fetched}`);
  console.log(`  skipped:            ${counters.skipped}`);
  console.log(`  errors:             ${counters.errors}`);
}

// Only run when executed directly (not when imported by tests) — same guard as
// src/scripts/backfill-customer-number.ts.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Backfill failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
