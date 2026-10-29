/**
 * Rate-change notice plumbing (Task 4.3, §3.6).
 *
 * Organization.platform_fee_bps is a support-only knob — never exposed in
 * patchOrgSchema or any settings UI; only ServWave changes it, via a direct
 * DB update or an internal tool (not a customer-facing form). This module
 * does NOT write that column. Call notifyPlatformFeeRateChange AFTER the
 * column has already been changed elsewhere — it only fires the required
 * within-ceiling advance notice: a ≥30-day-out co-branded email + a BILLING
 * FEED notification to every active org ADMIN. No re-acceptance is implied
 * or required for a within-ceiling change.
 *
 * The actual trigger — an admin/support tool that updates platform_fee_bps
 * AND calls this — is intentionally deferred: the launch rate is fixed at
 * 0.5% and nothing changes it today. This ships the plumbing only.
 */
import { prisma } from './prisma';
import { logger } from './logger';
import { emit } from '../services/notifications/notificationService';
import { sendPaymentsRateChangeNotice } from './email';
import { PLATFORM_FEE_CEILING_BPS } from './legal';

const NOTICE_DAYS = 30;

function formatBpsAsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function formatEffectiveDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Mirrors webhook.controller.ts's notificationAlreadyExists (Task 1.9) — a
// pre-check so we know BEFORE calling emit() (which would itself insert the
// row) whether to skip re-emailing every admin on a retried/duplicate
// invocation. Duplicating this one findFirst locally is cheaper than
// exporting it from a controller for a single new caller.
async function notificationAlreadyExists(orgId: string, dedupKey: string): Promise<boolean> {
  const existing = await prisma.notification.findFirst({ where: { organization_id: orgId, dedup_key: dedupKey } });
  return !!existing;
}

/**
 * Fire the within-ceiling rate-change notice for `organizationId`: oldBps →
 * newBps, effective 30 days from now. Throws if newBps exceeds the 2%
 * ceiling (an over-ceiling change needs a different, not-yet-built
 * re-acceptance flow — never just a notice) or if the org can't be found.
 * No-ops silently when oldBps === newBps (nothing actually changed).
 */
export async function notifyPlatformFeeRateChange(
  organizationId: string,
  oldBps: number,
  newBps: number,
): Promise<void> {
  if (oldBps === newBps) return; // no actual change — nothing to notify

  if (newBps > PLATFORM_FEE_CEILING_BPS) {
    throw new Error(
      `notifyPlatformFeeRateChange: ${newBps}bps exceeds the ${PLATFORM_FEE_CEILING_BPS}bps ceiling — an over-ceiling change needs re-acceptance, not this within-ceiling notice.`,
    );
  }

  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  if (!org) throw new Error(`notifyPlatformFeeRateChange: organization ${organizationId} not found`);

  const effective = new Date(Date.now() + NOTICE_DAYS * 24 * 60 * 60 * 1000);
  const oldRate = formatBpsAsPercent(oldBps);
  const newRate = formatBpsAsPercent(newBps);
  const effectiveDate = formatEffectiveDate(effective);
  const dedupKey = `billing.platform_fee_rate_changed:${newBps}:${effective.toISOString().slice(0, 10)}`;

  // Pre-check BEFORE emit() (which would itself insert the row) — see
  // notificationAlreadyExists's doc comment above.
  const alreadyNotified = await notificationAlreadyExists(organizationId, dedupKey);

  await emit({
    verb: 'billing.platform_fee_rate_changed',
    organizationId,
    actorId: null,
    object: { type: 'ORGANIZATION', id: organizationId, label: org.name ?? 'ServWave Payments' },
    entity: {},
    data: { new_rate: newRate, effective_date: effectiveDate },
    dedupKey,
  }).catch((err) => logger.error(`Failed to emit billing.platform_fee_rate_changed for org ${organizationId}:`, err));

  if (alreadyNotified) return; // a re-delivered/retried call must not re-email

  const admins = await prisma.user.findMany({
    where: { organization_id: organizationId, role: 'ADMIN', is_active: true },
    select: { email: true },
  });
  for (const admin of admins) {
    sendPaymentsRateChangeNotice({
      organizationId,
      to: admin.email,
      orgName: org.name ?? 'your organization',
      oldRate,
      newRate,
      effectiveDate,
    }).catch((err) => logger.error(`Failed to send rate-change notice email for org ${organizationId}:`, err));
  }
}
