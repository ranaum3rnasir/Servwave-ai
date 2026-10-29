import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { writeSettingsAudit } from '../lib/audit';

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// R5c (2026-07-22) — org-level custom tax rates (port-plan §3.3). Free-standing named rates, not
// tied to a state_code: an org's real combined rate (state + county/city) often has no single row
// in the global StateTaxRate table. state-tax-rate.controller.ts's list() merges these in
// alongside the global states so ReceiptCard.tsx's tax-rate picker needs no changes.

export const createOrgTaxRateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  rate: z.number().min(0).max(1),
});

// `is_visible` is update-only: a hand-made rate created from inside a picker is always visible
// (the user is adding it precisely so they can apply it), so there is nothing to choose on create.
export const updateOrgTaxRateSchema = createOrgTaxRateSchema.partial().extend({
  is_visible: z.boolean().optional(),
});

export async function list(req: Request, res: Response) {
  try {
    const rates = await prisma.orgTaxRate.findMany({
      where: tenantWhere(req),
      orderBy: { name: 'asc' },
    });
    res.json({ rates });
  } catch (err) {
    logger.error('List org tax rates error:', err);
    res.status(500).json({ error: 'Failed to list org tax rates' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof createOrgTaxRateSchema>;
    const rate = await prisma.orgTaxRate.create({
      data: {
        organization_id: req.user!.organization_id,
        name: body.name,
        rate: body.rate,
      },
    });
    await writeSettingsAudit(req, 'org_tax_rate.created', { name: rate.name, rate: body.rate });
    res.status(201).json({ rate });
  } catch (err) {
    logger.error('Create org tax rate error:', err);
    res.status(500).json({ error: 'Failed to create org tax rate' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.orgTaxRate.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Org tax rate not found' });
      return;
    }
    const body = req.body as z.infer<typeof updateOrgTaxRateSchema>;
    const rate = await prisma.orgTaxRate.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.rate !== undefined ? { rate: body.rate } : {}),
        ...(body.is_visible !== undefined ? { is_visible: body.is_visible } : {}),
      },
    });
    await writeSettingsAudit(req, 'org_tax_rate.updated', { id, fields: Object.keys(body) });
    res.json({ rate });
  } catch (err) {
    logger.error('Update org tax rate error:', err);
    res.status(500).json({ error: 'Failed to update org tax rate' });
  }
}

export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.orgTaxRate.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Org tax rate not found' });
      return;
    }
    await prisma.orgTaxRate.delete({ where: { id } });
    await writeSettingsAudit(req, 'org_tax_rate.deleted', { id, name: existing.name });
    res.status(204).send();
  } catch (err) {
    logger.error('Delete org tax rate error:', err);
    res.status(500).json({ error: 'Failed to delete org tax rate' });
  }
}
