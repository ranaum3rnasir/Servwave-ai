import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';

export const updateSettingSchema = z.object({
  value: z.string().min(1, 'Value is required'),
});

export async function getByKey(req: Request, res: Response) {
  try {
    const key = req.params.key as string;
    const orgId = req.user!.organization_id;
    const setting = await prisma.appSetting.findUnique({
      where: { organization_id_key: { organization_id: orgId, key } },
    });

    if (!setting) {
      res.status(404).json({ error: 'Setting not found' });
      return;
    }

    res.json({ data: setting });
  } catch (err) {
    logger.error('Failed to get setting:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateByKey(req: Request, res: Response) {
  try {
    const key = req.params.key as string;
    const value = req.body.value as string;
    const orgId = req.user!.organization_id;

    if (key === 'deposit_percentage') {
      const n = Number(value);
      if (!isFinite(n) || n < 0 || n > 100) {
        res.status(400).json({ error: 'deposit_percentage must be between 0 and 100' });
        return;
      }
      await prisma.organization.update({
        where: { id: orgId },
        data: { deposit_default_percentage: n },
      });
      res.json({ data: { key, value } });
      return;
    }

    const setting = await prisma.appSetting.upsert({
      where: { organization_id_key: { organization_id: orgId, key } },
      update: { value },
      create: { organization_id: orgId, key, value },
    });

    void logAudit({ req, action: 'setting.updated', resourceType: 'AppSetting', resourceId: key, metadata: { key } });
    res.json({ data: setting });
  } catch (err) {
    logger.error('Failed to update setting:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
