import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';

const entityTypeEnum = z.enum(['LEAD', 'JOB', 'CUSTOMER', 'PRICE_BOOK_ITEM']);

// ─── Zod Schemas ───────────────────────────────────────

export const createCustomFieldDefinitionSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/, 'key must be lowercase letters, numbers, and underscores'),
  label: z.string().min(1).max(200),
  // Only TEXT is exercised end to end this slice - NUMBER/DATE/SELECT/CHECKBOX are separate
  // later slices, so the create endpoint does not accept them yet.
  type: z.literal('TEXT'),
  entity_types: z.array(entityTypeEnum).min(1),
});

// SRVW-114 slice 3 - only the label and the entity scope are editable. `key` is the org-facing
// unique identifier, and `type` decides how every already-stored value is interpreted, so
// changing either after values exist would rename or reinterpret data rather than edit a
// definition. Both are absent from this schema, so zod strips them before the handler sees them.
export const updateCustomFieldDefinitionSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  entity_types: z.array(entityTypeEnum).min(1).optional(),
});

const listQuerySchema = z.object({
  entity_type: entityTypeEnum.optional(),
});

// Express types req.params values as `string | string[]`; every route here binds a single
// `:id`. Same one-liner the other controllers carry (customer.controller.ts et al).
function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// ─── Handlers ──────────────────────────────────────────

/** GET /api/custom-field-definitions?entity_type=JOB - this org's active field definitions. */
export async function list(req: Request, res: Response) {
  try {
    const parsedQuery = listQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: 'Invalid entity_type' });
      return;
    }
    const { entity_type } = parsedQuery.data;

    const custom_field_definitions = await prisma.customFieldDefinition.findMany({
      where: {
        ...tenantWhere(req),
        archived_at: null,
        ...(entity_type ? { entity_types: { has: entity_type } } : {}),
      },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });

    res.json({ custom_field_definitions });
  } catch (err) {
    logger.error('List custom field definitions error:', err);
    res.status(500).json({ error: 'Failed to list custom field definitions' });
  }
}

/** POST /api/custom-field-definitions - define a new org-wide field. */
export async function create(req: Request, res: Response) {
  try {
    const { key, label, type, entity_types } = req.body;
    const organization_id = req.user!.organization_id;

    const existing = await prisma.customFieldDefinition.findUnique({
      where: { organization_id_key: { organization_id, key } },
    });
    if (existing) {
      res.status(409).json({ error: 'A custom field with this key already exists' });
      return;
    }

    const custom_field_definition = await prisma.customFieldDefinition.create({
      data: { organization_id, key, label, type, entity_types },
    });

    res.status(201).json({ custom_field_definition });
  } catch (err) {
    logger.error('Create custom field definition error:', err);
    res.status(500).json({ error: 'Failed to create custom field definition' });
  }
}

/**
 * PATCH /api/custom-field-definitions/:id - relabel a field or change which entities it
 * applies to.
 *
 * Narrowing the scope deliberately leaves stored values alone. Values live in each row's own
 * `custom_fields` bag keyed by this definition's uuid, so a dropped entity simply stops
 * rendering them and reinstating it brings them straight back - an admin mis-clicking an
 * entity checkbox must not be a data-loss event, the same instinct as archive-not-delete.
 */
export async function update(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { label, entity_types } = req.body;

    // Scoped read first: prisma.update takes a bare unique id, so without this an admin could
    // rewrite another org's definition by guessing a uuid. 404, not 403 - a definition the
    // caller cannot see should not be confirmed to exist.
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Custom field not found' });
      return;
    }

    const custom_field_definition = await prisma.customFieldDefinition.update({
      where: { id },
      data: {
        ...(label !== undefined && { label }),
        ...(entity_types !== undefined && { entity_types }),
      },
    });

    res.json({ custom_field_definition });
  } catch (err) {
    logger.error('Update custom field definition error:', err);
    res.status(500).json({ error: 'Failed to update custom field definition' });
  }
}
