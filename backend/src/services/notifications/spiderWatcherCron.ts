/**
 * spiderWatcherCron.ts — Server-side scheduled sweep for Spider AI Lead Watcher
 *
 * Runs periodically (every 2 minutes) across all organizations that have Spider active.
 * Evaluates open leads against configured stage threshold clocks and dispatches alerts
 * with server-side deduplication.
 *
 * ARCH-1 / BUG-1 / BUG-2 / BUG-3 / SEC-8 / B-1 / B-2
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { dispatchSpiderAlerts } from './spiderDispatch.service';

export const SPIDER_STAGE_KEYS = {
  NEW_CONTACTED: 'new-contacted',
  CONTACTED_WALKTHROUGH: 'contacted-walkthrough-scheduled',
  WALKTHROUGH_ESTIMATE: 'walkthrough-completed-estimate',
} as const;

export interface StageThreshold {
  value: number;
  unit: 'Minute' | 'Hour' | 'Day' | 'Week' | string;
  enabled: boolean;
}

export function unitToMilliseconds(value: number, unit: string): number {
  const norm = (unit || '').toLowerCase().trim();
  if (norm.startsWith('min') || norm === 'm') {
    return value * 60 * 1000;
  }
  if (norm.startsWith('hour') || norm === 'h') {
    return value * 60 * 60 * 1000;
  }
  if (norm.startsWith('week') || norm === 'w') {
    return value * 7 * 24 * 60 * 60 * 1000;
  }
  // Default to Day
  return value * 24 * 60 * 60 * 1000;
}

/**
 * Sweeps all active organizations with Spider enabled and evaluates overdue leads.
 * Pass `now` to override current timestamp for testability.
 */
export async function runSpiderWatcherSweep(now: Date = new Date()): Promise<{
  organizationsChecked: number;
  leadsEvaluated: number;
  alertsDispatched: number;
}> {
  let organizationsChecked = 0;
  let leadsEvaluated = 0;
  let alertsDispatched = 0;

  try {
    // 1. Find all organizations with Spider Watcher explicitly enabled (SEC-8)
    const activeConfigs = await prisma.spiderWatcherConfig.findMany({
      where: { is_active: true },
    });

    organizationsChecked = activeConfigs.length;
    if (activeConfigs.length === 0) {
      return { organizationsChecked: 0, leadsEvaluated: 0, alertsDispatched: 0 };
    }

    for (const config of activeConfigs) {
      try {
        const orgId = config.organization_id;
        const stageThresholds = (config.stage_thresholds as unknown as Record<string, StageThreshold>) || {};
        const assignments = (config.assignments as any) || { adminRoles: ['ADMIN'], users: [], owner: true };
        const notifications = (config.notifications as any) || { email: true, sms: false, inApp: true, redFrame: true };
        const autoEnrollAll = config.auto_enroll_all_leads !== false;
        const selectedLeadIds = Array.isArray(config.selected_lead_ids)
          ? (config.selected_lead_ids as string[])
          : [];

        // Query open leads for this organization (BUG-2: unpaged query without pagination limit)
        const openLeads = await prisma.lead.findMany({
          where: {
            organization_id: orgId,
            status: {
              in: ['NEW', 'CONTACTED', 'ESTIMATED'],
            },
            lost_at: null,
            cancelled_at: null,
            won_at: null,
            ...(autoEnrollAll ? {} : { id: { in: selectedLeadIds } }),
          },
          select: {
            id: true,
            lead_number: true,
            status: true,
            created_at: true,
            contacted_at: true,
            walkthrough_first_booked_at: true,
            last_visit_completed_at: true,
            first_estimate_sent_at: true,
          },
        });

        leadsEvaluated += openLeads.length;

        for (const lead of openLeads) {
          try {
            let stageKey: string | null = null;
            let stageLabel = '';
            let stageStart: Date | null = null;

            // BUG-1 / B-2: Compute accurate stage category and stage clock
            if (!lead.contacted_at && lead.status === 'NEW' && !lead.walkthrough_first_booked_at && !lead.last_visit_completed_at) {
              // Stage 1: New lead has not been contacted
              stageKey = SPIDER_STAGE_KEYS.NEW_CONTACTED;
              stageLabel = 'New';
              stageStart = lead.created_at;
            } else if ((lead.contacted_at || lead.status !== 'NEW') && !lead.walkthrough_first_booked_at && !lead.last_visit_completed_at) {
              // Stage 2: Lead contacted, but no walkthrough scheduled
              stageKey = SPIDER_STAGE_KEYS.CONTACTED_WALKTHROUGH;
              stageLabel = 'Contacted';
              stageStart = lead.contacted_at || lead.created_at;
            } else if (lead.last_visit_completed_at && !lead.first_estimate_sent_at) {
              // Stage 3: Walkthrough completed, but estimate not sent
              stageKey = SPIDER_STAGE_KEYS.WALKTHROUGH_ESTIMATE;
              stageLabel = 'Walkthrough Completed';
              stageStart = lead.last_visit_completed_at;
            }

            if (!stageKey || !stageStart) {
              continue;
            }

            // Look up threshold configuration for this stage (matches canonical frontend keys & fallback aliases)
            const threshold: StageThreshold | undefined =
              stageThresholds[stageKey] ||
              (stageKey === SPIDER_STAGE_KEYS.NEW_CONTACTED
                ? stageThresholds['new'] || stageThresholds['new_lead']
                : stageKey === SPIDER_STAGE_KEYS.CONTACTED_WALKTHROUGH
                ? stageThresholds['contacted']
                : stageThresholds['estimate'] || stageThresholds['walkthrough']);

            if (!threshold || !threshold.enabled || !threshold.value || threshold.value <= 0) {
              continue;
            }

            const thresholdUnit = threshold.unit || 'Day';
            const thresholdMs = unitToMilliseconds(threshold.value, thresholdUnit);
            const elapsedMs = now.getTime() - stageStart.getTime();

            if (elapsedMs >= thresholdMs) {
              const unitMs = unitToMilliseconds(1, thresholdUnit);
              const elapsedValue = Math.max(1, Math.floor(elapsedMs / (unitMs || 86400000)));
              const elapsedSeconds = Math.floor(elapsedMs / 1000);

              // BUG-3 / B-1: Explicit deterministic deduplication key with organization, lead, stage, start day bucket and threshold
              const stageStartDay = stageStart.toISOString().slice(0, 10);
              const dedupeKey = `spider:${orgId}:${lead.id}:${stageKey}:${stageStartDay}:${threshold.value}${thresholdUnit}`;

              // Check if alert already dispatched for this stage and threshold window
              const existingLog = await prisma.spiderAlertLog.findUnique({
                where: { dedupe_key: dedupeKey },
                select: { id: true },
              });

              if (existingLog) {
                // Already alerted for this threshold breach
                continue;
              }

              // Dispatch the alert across configured pipes, passing dedupeKey (B-1)
              const result = await dispatchSpiderAlerts({
                organizationId: orgId,
                leadId: lead.id,
                stageLabel,
                elapsedValue,
                elapsedUnit: thresholdUnit,
                elapsedSeconds,
                assignments,
                notifications,
                actorId: null, // Automated sweep
                appBaseUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
                dedupeKey,
              });

              if (result.ok && !result.alreadyAlerted) {
                alertsDispatched++;
              }
            }
          } catch (leadErr) {
            logger.warn(`[spiderWatcherCron] Error evaluating lead ${lead.id}:`, leadErr);
          }
        }
      } catch (orgErr) {
        logger.error(`[spiderWatcherCron] Error evaluating org ${config.organization_id}:`, orgErr);
      }
    }
  } catch (err) {
    logger.error('[spiderWatcherCron] Sweep failed:', err);
  }

  return { organizationsChecked, leadsEvaluated, alertsDispatched };
}
