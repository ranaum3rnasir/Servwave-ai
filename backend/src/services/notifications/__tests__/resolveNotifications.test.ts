import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveScheduleJobNotifications } from '../resolveNotifications';
import { prisma } from '../../../lib/prisma';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    notification: { findMany: vi.fn() },
    notificationRecipient: { updateMany: vi.fn() },
  },
}));
vi.mock('../../../lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const ORG = 'org-1';
const EST = 'est-1';

beforeEach(() => vi.clearAllMocks());

describe('resolveScheduleJobNotifications', () => {
  it('stamps acted_at/read_at on the actionable recipient rows of the estimate\'s SCHEDULE_JOB notifications', async () => {
    (prisma.notification.findMany as any).mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
    (prisma.notificationRecipient.updateMany as any).mockResolvedValue({ count: 1 });

    await resolveScheduleJobNotifications(EST, ORG);

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { organization_id: ORG, object_type: 'ESTIMATE', object_id: EST, action_type: 'SCHEDULE_JOB' },
      select: { id: true },
    });
    expect(prisma.notificationRecipient.updateMany).toHaveBeenCalledWith({
      where: { notification_id: { in: ['n1', 'n2'] }, organization_id: ORG, needs_action: true, acted_at: null },
      data: expect.objectContaining({ acted_at: expect.any(Date), read_at: expect.any(Date) }),
    });
  });

  it('does nothing (no update) when there are no matching notifications', async () => {
    (prisma.notification.findMany as any).mockResolvedValue([]);
    await resolveScheduleJobNotifications(EST, ORG);
    expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('never throws when Prisma rejects (best-effort)', async () => {
    (prisma.notification.findMany as any).mockRejectedValue(new Error('db down'));
    await expect(resolveScheduleJobNotifications(EST, ORG)).resolves.toBeUndefined();
  });

  it('never throws when updateMany rejects', async () => {
    (prisma.notification.findMany as any).mockResolvedValue([{ id: 'n1' }]);
    (prisma.notificationRecipient.updateMany as any).mockRejectedValue(new Error('db down'));
    await expect(resolveScheduleJobNotifications(EST, ORG)).resolves.toBeUndefined();
  });

  it('uses the injected client instead of the global prisma when supplied', async () => {
    const txClient = {
      notification: { findMany: vi.fn().mockResolvedValue([{ id: 'n1' }]) },
      notificationRecipient: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await resolveScheduleJobNotifications(EST, ORG, txClient as any);

    expect(txClient.notification.findMany).toHaveBeenCalled();
    expect(txClient.notificationRecipient.updateMany).toHaveBeenCalled();
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });
});
