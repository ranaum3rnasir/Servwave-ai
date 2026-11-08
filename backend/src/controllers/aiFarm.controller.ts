import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendAiFarmBookingEmails } from '../lib/email';
import { logger } from '../lib/logger';
import { zodValidationFailure } from '../middleware/validate';

export const bookCallSchema = z
  .object({
    agentName: z.string().min(1).max(120),
    agentRole: z.string().min(1).max(160),
    day: z.string().min(1).max(60),
    slot: z.string().min(1).max(40),
  })
  .strict();

export async function bookCall(req: Request, res: Response) {
  const { agentName, agentRole, day, slot } = req.body;
  const user = req.user!;

  if (agentName && typeof agentName === 'string' && agentName.trim().toLowerCase() === 'spider') {
    return res.status(400).json({
      error: 'Spider is a live active agent and does not require booking a call. Please configure it directly.',
    });
  }

  try {
    const org = await prisma.organization.findUnique({
      where: { id: user.organization_id },
      select: { name: true },
    });

    await sendAiFarmBookingEmails({
      requesterName: `${user.first_name} ${user.last_name}`.trim(),
      requesterEmail: user.email,
      orgName: org?.name ?? 'their business',
      agentName,
      agentRole,
      day,
      slot,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('AI Agentic Farm booking failed:', err);
    res.status(502).json({ error: 'Could not send the booking request. Please try again.' });
  }
}

// ─── Spider Agent Configuration (ARCH-1, SEC-8) ─────────────────────────────

export const updateSpiderConfigSchema = z
  .object({
    isActive: z.boolean().optional(),
    autoEnrollAllLeads: z.boolean().optional(),
    selectedLeadIds: z.array(z.string().uuid()).optional(),
    stageThresholds: z.record(z.any()).optional(),
    notifications: z
      .object({
        email: z.boolean().optional(),
        sms: z.boolean().optional(),
        inApp: z.boolean().optional(),
        redFrame: z.boolean().optional(),
      })
      .optional(),
    assignments: z
      .object({
        adminRoles: z.array(z.string()).optional(),
        users: z.array(z.string()).optional(),
        owner: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

export async function getSpiderConfig(req: Request, res: Response) {
  const user = req.user!;
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can access Spider configuration' });
  }

  try {
    const config = await prisma.spiderWatcherConfig.findUnique({
      where: { organization_id: user.organization_id },
    });

    if (!config) {
      return res.json({
        ok: true,
        config: {
          isActive: false,
          autoEnrollAllLeads: true,
          selectedLeadIds: [],
          stageThresholds: {},
          notifications: {
            email: true,
            sms: false,
            inApp: true,
            redFrame: true,
          },
          assignments: {
            adminRoles: ['ADMIN'],
            users: [],
            owner: true,
          },
        },
      });
    }

    res.json({
      ok: true,
      config: {
        isActive: config.is_active,
        autoEnrollAllLeads: config.auto_enroll_all_leads,
        selectedLeadIds: config.selected_lead_ids,
        stageThresholds: config.stage_thresholds,
        notifications: config.notifications,
        assignments: config.assignments,
        updatedAt: config.updated_at,
      },
    });
  } catch (err) {
    logger.error('Failed to retrieve Spider config:', err);
    res.status(500).json({ error: 'Failed to retrieve Spider configuration' });
  }
}

export function hasAtLeastOneStageThreshold(stageThresholds: any): boolean {
  if (!stageThresholds) return false;
  if (Array.isArray(stageThresholds)) {
    return stageThresholds.some((st) => {
      const val = st?.value ?? st?.days ?? st?.duration;
      return typeof val === 'number' && val > 0 && st?.enabled !== false;
    });
  }
  if (typeof stageThresholds === 'object') {
    return Object.values(stageThresholds).some((st: any) => {
      if (typeof st === 'number') return st > 0;
      const val = st?.value ?? st?.days ?? st?.duration;
      return typeof val === 'number' && val > 0 && st?.enabled !== false;
    });
  }
  return false;
}

export async function updateSpiderConfig(req: Request, res: Response) {
  const user = req.user!;

  // SEC-8: Only Admins can configure Spider settings
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can update Spider configuration' });
  }

  const body = req.body;

  // Enforce that turning Spider active requires at least one stage threshold > 0
  if (body.isActive === true) {
    let thresholdsToCheck = body.stageThresholds;
    if (thresholdsToCheck === undefined) {
      const existing = await prisma.spiderWatcherConfig.findUnique({
        where: { organization_id: user.organization_id },
        select: { stage_thresholds: true },
      });
      thresholdsToCheck = existing?.stage_thresholds;
    }

    if (!hasAtLeastOneStageThreshold(thresholdsToCheck)) {
      return res.status(400).json({
        error: 'At least one stage threshold must be configured with a duration greater than 0 to activate Spider',
      });
    }
  }

  try {
    const upserted = await prisma.spiderWatcherConfig.upsert({
      where: { organization_id: user.organization_id },
      create: {
        organization_id: user.organization_id,
        is_active: body.isActive ?? false,
        auto_enroll_all_leads: body.autoEnrollAllLeads ?? true,
        selected_lead_ids: body.selectedLeadIds ?? [],
        stage_thresholds: body.stageThresholds ?? {},
        notifications: body.notifications ?? {},
        assignments: body.assignments ?? {},
      },
      update: {
        ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        ...(body.autoEnrollAllLeads !== undefined ? { auto_enroll_all_leads: body.autoEnrollAllLeads } : {}),
        ...(body.selectedLeadIds !== undefined ? { selected_lead_ids: body.selectedLeadIds } : {}),
        ...(body.stageThresholds !== undefined ? { stage_thresholds: body.stageThresholds } : {}),
        ...(body.notifications !== undefined ? { notifications: body.notifications } : {}),
        ...(body.assignments !== undefined ? { assignments: body.assignments } : {}),
      },
    });

    res.json({
      ok: true,
      config: {
        isActive: upserted.is_active,
        autoEnrollAllLeads: upserted.auto_enroll_all_leads,
        selectedLeadIds: upserted.selected_lead_ids,
        stageThresholds: upserted.stage_thresholds,
        notifications: upserted.notifications,
        assignments: upserted.assignments,
        updatedAt: upserted.updated_at,
      },
    });
  } catch (err) {
    logger.error('Failed to update Spider config:', err);
    res.status(500).json({ error: 'Failed to save Spider configuration' });
  }
}

// ─── Spider Alert Logs (SEC-1, SEC-6, RULE-1) ────────────────────────────────

export const getSpiderLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function getSpiderLogs(req: Request, res: Response) {
  const user = req.user!;
  if (user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only administrators can access Spider notification logs' });
  }

  const parseResult = getSpiderLogsQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    return res.status(400).json(zodValidationFailure(parseResult.error));
  }
  const { page, limit } = parseResult.data;

  try {
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      prisma.spiderAlertLog.findMany({
        where: { organization_id: user.organization_id },
        select: {
          id: true,
          lead_id: true,
          lead_number: true,
          customer_name: true,
          company_name: true,
          service_request: true,
          service_location: true,
          stage_name: true,
          inactive_days: true,
          inactive_unit: true,
          channels: true,
          recipients: true,
          status: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      prisma.spiderAlertLog.count({
        where: { organization_id: user.organization_id },
      }),
    ]);

    res.json({
      ok: true,
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error('Failed to read Spider logs:', err);
    res.status(500).json({ error: 'Failed to retrieve Spider notification logs' });
  }
}
