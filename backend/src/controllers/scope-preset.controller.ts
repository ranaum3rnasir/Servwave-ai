import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';

// §D / P1 #9 — reusable named/priced scope-of-work presets, org-scoped.

export const createScopePresetSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  emoji: z.string().max(8).nullable().optional(),
  scope_text: z.string().min(1, 'Scope text is required').max(5000),
  priced: z.boolean().default(false),
  price: z.number().min(0).nullable().optional(),
  // B7 — a priced scope carries taxability + cost basis too (ScopeOfWork's shape,
  // scopes.ts/addScope); without these, a priced/taxed scope-of-work saved as a preset silently
  // came back unpriced/untaxed on reapply. Column support already existed on ScopePreset.
  is_taxable: z.boolean().default(true),
  internal_cost: z.number().min(0).nullable().optional(),
  // R5a (2026-07-21) — free-text grouping tag (not a relational category), trimmed to null on
  // blank so an empty-string filter chip never gets created.
  category: z.string().max(100).nullable().optional(),
});

export async function list(req: Request, res: Response) {
  try {
    const search = (req.query.q as string) || '';
    const category = (req.query.category as string) || '';
    const presets = await prisma.scopePreset.findMany({
      where: {
        ...tenantWhere(req),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
        ...(category ? { category } : {}),
      },
      orderBy: { name: 'asc' },
    });
    res.json({ presets });
  } catch (err) {
    logger.error('List scope presets error:', err);
    res.status(500).json({ error: 'Failed to list scope presets' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof createScopePresetSchema>;
    const preset = await prisma.scopePreset.create({
      data: {
        organization_id: req.user!.organization_id,
        name: body.name,
        emoji: body.emoji ?? null,
        scope_text: body.scope_text,
        priced: body.priced,
        price: body.priced ? (body.price ?? null) : null,
        is_taxable: body.is_taxable,
        internal_cost: body.internal_cost ?? null,
        category: body.category?.trim() || null,
      },
    });
    void logAudit({ req, action: 'estimate.scope_preset_saved', resourceType: 'ScopePreset', resourceId: preset.id, metadata: { name: preset.name } });
    res.status(201).json({ preset });
  } catch (err) {
    logger.error('Create scope preset error:', err);
    res.status(500).json({ error: 'Failed to create scope preset' });
  }
}
