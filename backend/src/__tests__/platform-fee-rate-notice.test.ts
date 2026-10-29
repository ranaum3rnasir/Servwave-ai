import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { sendPaymentsRateChangeNotice } from '../lib/email';
import { notifyPlatformFeeRateChange } from '../lib/platform-fee-rate-notice';

// Task 4.3 (§3.6) — notifyPlatformFeeRateChange is the small internal
// "admin/support action" a support script/tool calls AFTER
// Organization.platform_fee_bps has already been changed via the DB/runbook
// path (this module never writes that column — see
// lib/platform-fee-rate-notice.ts's doc comment). It fires the required
// within-ceiling advance notice: a real billing.platform_fee_rate_changed
// BILLING/FEED notification (same emit()-through-to-prisma style as
// webhook.test.ts's account-lifecycle notification tests) + a co-branded
// email to every active org ADMIN (mocked here — the real sender is covered
// by email-payments-rate-change-notice.test.ts).

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
  notification: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  notificationRecipient: { createMany: ReturnType<typeof vi.fn> };
};

const mockSendNotice = sendPaymentsRateChangeNotice as ReturnType<typeof vi.fn>;

const ORG_ID = 'org_ratechange_1';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue({ name: 'Acme Plumbing' });
  mockPrisma.user.findMany.mockResolvedValue([{ id: 'admin1', role: 'ADMIN', email: 'admin1@acme.test' }]);
  mockPrisma.notification.findFirst.mockResolvedValue(undefined);
  mockPrisma.notification.create.mockResolvedValue({ id: 'notif1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notifyPlatformFeeRateChange (Task 4.3 — rate-change notice plumbing)', () => {
  it('emits a real billing.platform_fee_rate_changed BILLING/FEED notification for org ADMINs, effective 30 days out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));

    await notifyPlatformFeeRateChange(ORG_ID, 50, 75);

    expect(mockPrisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        organization_id: ORG_ID,
        verb: 'billing.platform_fee_rate_changed',
        category: 'BILLING',
        object_type: 'ORGANIZATION',
        priority: 'FEED',
        needs_action: false,
        dedup_key: 'billing.platform_fee_rate_changed:75:2026-08-20',
        data: expect.objectContaining({ new_rate: '0.75%', effective_date: 'August 20, 2026' }),
      }),
    }));
    expect(mockPrisma.notificationRecipient.createMany).toHaveBeenCalledWith({
      data: [{ notification_id: 'notif1', organization_id: ORG_ID, recipient_id: 'admin1', priority: 'FEED', needs_action: false }],
    });
  });

  it('emails every active admin the old rate, new rate, and the 30-day-out effective date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z'));
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'admin1', role: 'ADMIN', email: 'admin1@acme.test' },
      { id: 'admin2', role: 'ADMIN', email: 'admin2@acme.test' },
    ]);

    await notifyPlatformFeeRateChange(ORG_ID, 50, 75);

    expect(mockSendNotice).toHaveBeenCalledTimes(2);
    expect(mockSendNotice).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      to: 'admin1@acme.test',
      orgName: 'Acme Plumbing',
      oldRate: '0.50%',
      newRate: '0.75%',
      effectiveDate: 'August 20, 2026',
    });
    expect(mockSendNotice).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      to: 'admin2@acme.test',
      orgName: 'Acme Plumbing',
      oldRate: '0.50%',
      newRate: '0.75%',
      effectiveDate: 'August 20, 2026',
    });
  });

  it('rejects a newBps above the 2% ceiling — an over-ceiling change needs re-acceptance, not this notice — without touching the DB', async () => {
    await expect(notifyPlatformFeeRateChange(ORG_ID, 50, 201)).rejects.toThrow(/ceiling/);

    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockSendNotice).not.toHaveBeenCalled();
  });

  it('accepts newBps exactly at the 200bps (2%) ceiling', async () => {
    await expect(notifyPlatformFeeRateChange(ORG_ID, 50, 200)).resolves.toBeUndefined();
    expect(mockPrisma.notification.create).toHaveBeenCalled();
  });

  it('is a silent no-op when newBps === oldBps (nothing actually changed)', async () => {
    await notifyPlatformFeeRateChange(ORG_ID, 50, 50);

    expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockSendNotice).not.toHaveBeenCalled();
  });

  it('throws when the organization cannot be found', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);

    await expect(notifyPlatformFeeRateChange('missing_org', 50, 75)).rejects.toThrow(/not found/);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('does not re-create the Notification or re-email admins for a duplicate dedup key (retried invocation)', async () => {
    mockPrisma.notification.findFirst.mockResolvedValue({ id: 'existing_notif' });

    await notifyPlatformFeeRateChange(ORG_ID, 50, 75);

    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockSendNotice).not.toHaveBeenCalled();
  });
});
