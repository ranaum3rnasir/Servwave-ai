/**
 * resolveNotifications.ts — clear actionable notifications once their real-world
 * action is done. Best-effort: never throws (a failure here must not break the
 * parent action, mirroring emit()).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/**
 * Mark the open "Schedule job" (action_type SCHEDULE_JOB) notification(s) for an
 * estimate as acted, so they leave the Dispatcher's pinned "needs action" list
 * once a job has actually been created from that estimate. Only needs_action
 * rows are touched — informational copies (Sales/Admin) are left untouched.
 */
export async function resolveScheduleJobNotifications(
  estimateId: string,
  organizationId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  try {
    const notifs = await client.notification.findMany({
      where: {
        organization_id: organizationId,
        object_type: 'ESTIMATE',
        object_id: estimateId,
        action_type: 'SCHEDULE_JOB',
      },
      select: { id: true },
    });
    if (notifs.length === 0) return;
    const now = new Date();
    await client.notificationRecipient.updateMany({
      where: {
        notification_id: { in: notifs.map((n) => n.id) },
        organization_id: organizationId,
        needs_action: true,
        acted_at: null,
      },
      data: { acted_at: now, read_at: now },
    });
  } catch (err) {
    logger.warn(`resolveScheduleJobNotifications failed for estimate ${estimateId}: ${String(err)}`);
  }
}
