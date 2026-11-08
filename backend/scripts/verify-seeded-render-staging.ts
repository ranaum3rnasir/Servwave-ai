#!/usr/bin/env tsx
/**
 * Read-only staging check: render every seeded built-in automation's subject and
 * body against a REAL staging record, and report any merge token that failed to
 * resolve. Writes nothing, sends nothing.
 *
 *   npx tsx scripts/verify-seeded-render-staging.ts <orgId> <jobId> <leadId>
 */
import { prisma } from '../src/lib/prisma';
import { loadExecutionBundle } from '../src/services/automations/context';
import { renderMergeFields } from '../src/services/automations/renderMergeFields';
import { DEFAULT_AUTOMATIONS } from '../src/services/automations/defaultAutomations';

const JOB_TRIGGERS = ['JOB_SCHEDULED', 'JOB_RESCHEDULED', 'TECH_ASSIGNED', 'TECH_UNASSIGNED', 'JOB_EN_ROUTE'];

async function main(): Promise<void> {
  const [orgId, jobId, leadId, estimateId] = process.argv.slice(2);
  if (!orgId || !jobId || !leadId || !estimateId) throw new Error('usage: <orgId> <jobId> <leadId> <estimateId>');

  // Request-time text the live row cannot reproduce — the cancellation-reason path.
  const eventPayload = { mergeFields: { 'event.reason': 'Customer had a scheduling conflict' } };
  const bundles: Record<string, Awaited<ReturnType<typeof loadExecutionBundle>>> = {
    job: await loadExecutionBundle({ organizationId: orgId, entityType: 'job', entityId: jobId, dedupeKey: 'verify:job', eventPayload }),
    lead: await loadExecutionBundle({ organizationId: orgId, entityType: 'lead', entityId: leadId, dedupeKey: 'verify:lead', eventPayload }),
    estimate: await loadExecutionBundle({ organizationId: orgId, entityType: 'estimate', entityId: estimateId, dedupeKey: 'verify:est', eventPayload }),
  };

  let unresolved = 0;
  for (const def of DEFAULT_AUTOMATIONS) {
    const kind = def.trigger_type.startsWith('ESTIMATE')
      ? 'estimate'
      : JOB_TRIGGERS.includes(def.trigger_type)
        ? 'job'
        : 'lead';
    const loaded = bundles[kind];
    if (!loaded) { console.log(`\n${def.builtin_key}: SKIPPED (no ${kind} bundle)`); continue; }

    // The entity bundle is the WHOLE render context. It used to need one addition here -
    // executors.ts injected a per-address recipient name that no entity load could supply -
    // and that field was removed on 2026-09-15 (see `BASE` in catalog.ts), so a bundle that
    // leaves any token unresolved below is now a real gap rather than a known omission.
    const ctx = loaded.bundle.mergeCtx;
    const subject = renderMergeFields(def.subject, ctx, { html: false });
    const body = renderMergeFields(def.body, ctx, { html: false });
    const leftover = [...`${subject} ${body}`.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]);
    if (leftover.length > 0) unresolved += leftover.length;

    console.log(`\n${def.builtin_key}  [${kind}]`);
    console.log(`  subject: ${subject}`);
    console.log(`  body:    ${body}`);
    if (leftover.length > 0) console.log(`  UNRESOLVED TOKENS: ${leftover.join(', ')}`);
  }

  console.log(`\n${unresolved === 0 ? 'PASS' : 'FAIL'} — ${unresolved} unresolved merge token(s) across all 13`);
  if (unresolved > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAILED:', err instanceof Error ? err.message : err); process.exit(1); });
