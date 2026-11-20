import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { equalsIgnoringCase } from '../lib/name-match';
import { canAccessRow } from '../lib/permissions/enforce';
import { canReadCustomerById } from '../lib/permissions/customerScope';
import type { TagEntityType } from '../lib/tags';

// ─── Zod Schemas ───────────────────────────────────────

// Trim BEFORE the length checks - see the note on updateTagSchema below. This
// half of the bug predates the Settings tag card: without it POST could still
// mint the blank tag that PATCH can no longer create.
export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional()
    .default('#6B7280'),
});

// `.trim()` FIRST, then the length checks - zod applies a ZodString's checks in
// the order they are chained, so `.min(1).max(50).transform(s => s.trim())` sized
// the RAW string and trimmed afterwards. A name of nothing but spaces therefore
// cleared min(1) and left the schema as '', which the handler wrote to the shared
// Tag row: an empty chip on every record carrying the tag, unfindable by name.
// The same ordering rejected 52 characters that trim to a legal 50.
export const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.color !== undefined, {
    message: 'Provide name or color',
  });

// Same trim-before-length order as createTagSchema/updateTagSchema above. These two
// schemas could never mint a BLANK tag - `resolveTagId` and the `.refine()` below both
// treat a post-trim '' as falsy and answer 400 - but chained the old way they kept the
// other half of the bug: `max(50)` read the RAW string, so a legal 50-character name
// typed with surrounding whitespace was rejected on every per-record tag route while
// the same name succeeded on POST /api/tags.
export const addTagToEntitySchema = z.object({
  tag_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional(),
}).refine(
  (data) => Boolean(data.tag_id) || Boolean(data.name),
  { message: 'Provide either tag_id or name' }
);

/** @deprecated Alias kept for legacy imports. Use addTagToEntitySchema. */
export const addTagToLeadSchema = addTagToEntitySchema;

// List-level bulk tag (Customers list page). Field-for-field copy of addTagToEntitySchema, NOT
// an intersection with it - addTagToEntitySchema is a ZodEffects (post-.refine()) and `.and()`
// would change the parsed type.
export const bulkTagEntitySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  tag_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color')
    .optional(),
}).refine(
  (data) => Boolean(data.tag_id) || Boolean(data.name),
  { message: 'Provide either tag_id or name' }
);

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

/**
 * Verify the target entity exists within the requesting org. Returns true if
 * the entity was found, false otherwise.
 */
async function entityExistsInOrg(
  req: Request,
  entityType: TagEntityType,
  entityId: string
): Promise<boolean> {
  const where = { id: entityId, ...tenantWhere(req) };
  switch (entityType) {
    case 'CUSTOMER': return Boolean(await prisma.customer.findFirst({ where, select: { id: true } }));
    case 'LEAD':     return Boolean(await prisma.lead.findFirst({ where, select: { id: true } }));
    case 'ESTIMATE': return Boolean(await prisma.estimate.findFirst({ where, select: { id: true } }));
    case 'JOB':      return Boolean(await prisma.job.findFirst({ where, select: { id: true } }));
    case 'INVOICE':  return Boolean(await prisma.invoice.findFirst({ where, select: { id: true } }));
    default:         return false;
  }
}

// ─── Handlers ──────────────────────────────────────────

type TagTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Tag names are unique per org ignoring case, enforced here (no lower(name) index exists: a raw
 * index would show up as schema drift). The check and the write share one transaction behind a
 * per-org advisory lock, so two simultaneous writes that differ only by case cannot both pass it.
 */
async function withTagNameLock<T>(orgId: string, work: (tx: TagTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tag-names:${orgId}`}))`;
    return work(tx);
  });
}

/** The tag in this org whose name equals `name` in any case; the exact-case row wins, then the oldest. */
async function findTagIgnoringCase(tx: TagTx, orgId: string, name: string, excludeId?: string) {
  const exact = await tx.tag.findFirst({
    where: { organization_id: orgId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (exact) return exact;
  return tx.tag.findFirst({
    where: {
      organization_id: orgId,
      name: equalsIgnoringCase(name),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    orderBy: { created_at: 'asc' },
  });
}

/** GET /api/tags — list this org's tags (for autocomplete and the Settings card) */
export async function list(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const [tags, assignmentCounts, legacyCounts] = await Promise.all([
      prisma.tag.findMany({
        where: tenantWhere(req),
        select: { id: true, name: true, color: true },
        orderBy: { name: 'asc' },
      }),
      // One grouped query for all five record types (customer, lead, estimate, job, invoice).
      prisma.tagAssignment.groupBy({
        by: ['tag_id'],
        where: { organization_id: orgId },
        _count: { _all: true },
      }),
      // Legacy lead links that never got a tag_assignments twin (N-6). A twinned link is already
      // in the count above, so it is excluded here and never counted twice.
      prisma.$queryRaw<{ tag_id: string; n: number }[]>`
        SELECT lt.tag_id AS tag_id, count(*)::int AS n
        FROM lead_tags lt
        JOIN tags t ON t.id = lt.tag_id
        WHERE t.organization_id = ${orgId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM tag_assignments ta
            WHERE ta.tag_id = lt.tag_id AND ta.entity_type = 'LEAD' AND ta.entity_id = lt.lead_id
          )
        GROUP BY lt.tag_id`,
    ]);
    const used = new Map<string, number>();
    for (const row of assignmentCounts) used.set(row.tag_id, row._count._all);
    for (const row of legacyCounts) used.set(row.tag_id, (used.get(row.tag_id) ?? 0) + Number(row.n));
    res.json({ tags: tags.map((t) => ({ ...t, usage_count: used.get(t.id) ?? 0 })) });
  } catch (err) {
    logger.error('List tags error:', err);
    res.status(500).json({ error: 'Failed to list tags' });
  }
}

/** POST /api/tags — create a new tag (per-org) */
export async function create(req: Request, res: Response) {
  try {
    // Already parsed by `createTagSchema` on the route.
    const { name, color } = req.body as z.infer<typeof createTagSchema>;
    const orgId = req.user!.organization_id;

    const outcome = await withTagNameLock(orgId, async (tx) => {
      const existing = await findTagIgnoringCase(tx, orgId, name);
      if (existing) return { existing } as const;
      const created = await tx.tag.create({
        data: { name, color, organization_id: orgId },
        select: { id: true, name: true, color: true },
      });
      return { created } as const;
    });
    if ('existing' in outcome) {
      res.status(409).json({ error: 'Tag already exists', tag: outcome.existing });
      return;
    }

    res.status(201).json({ tag: outcome.created });
  } catch (err) {
    logger.error('Create tag error:', err);
    res.status(500).json({ error: 'Failed to create tag' });
  }
}

// SRVW-105 step 12 - three-way split of addTagToEntity's body.
// Split into THREE ordered helpers, not two, so the single-row factory below can call them in
// EXACTLY today's guard order: entity-existence FIRST (before any tag read or find-or-create),
// then tag resolution, then the assignment write. Folding the entity check into the assignment
// helper would let a bulk apply resolve/create a brand-new tag BEFORE 404ing on a nonexistent
// entity - a new write on a 404 path.

/** Verify the target entity exists within the requesting org (404 result if not). */
async function ensureEntityInOrg(
  req: Request,
  entityType: TagEntityType,
  entityId: string,
): Promise<{ ok: true } | { ok: false; status: 404; error: string }> {
  const exists = await entityExistsInOrg(req, entityType, entityId);
  if (!exists) {
    return { ok: false, status: 404, error: `${entityType.toLowerCase()} not found` };
  }
  return { ok: true };
}

/**
 * Per-instance ownership gate (tag row-scope fix, 2026-08-05). The route guard
 * (`canDo('update', subject)`) is subject-level CASL - it has no row to evaluate a condition
 * like OWN_JOB against, so it passes for every row once the role holds the bare grant; combined
 * with entityExistsInOrg's tenancy-only check, a role with a conditional `update` grant on a
 * subject (e.g. TECHNICIAN on Job) could tag ANY row in the org, not just one it can otherwise
 * reach - despite read/delete/assign/manage_lines on the same subject all being properly
 * row-scoped. Reuses canAccessRow, the SAME per-instance check job.controller.ts's own
 * update/delete handlers already use, keyed off the subject's READ scope (the established
 * precedent for "can this actor reach this specific row", not a new update-scope concept).
 * #2041: CUSTOMER now has a ScopeResource (previously false — "CUSTOMER has no ScopeResource"),
 * so it gets the same per-instance check the other four subjects use, via `canReadCustomerById`
 * (the decision-3 proof-only probe). Its refusal is 404 "customer not found" — NOT the 403 the
 * other arms use (R5): a 403 here would confirm the row exists, turning the tag endpoint into an
 * existence oracle for a customer the requester cannot otherwise read.
 */
async function ensureRowScopeAccess(
  req: Request,
  entityType: TagEntityType,
  entityId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
  if (entityType === 'CUSTOMER') {
    const readable = await canReadCustomerById(req, entityId);
    return readable ? { ok: true } : { ok: false, status: 404, error: 'customer not found' };
  }
  let allowed: boolean;
  switch (entityType) {
    case 'LEAD':     allowed = await canAccessRow(req, 'Lead', prisma.lead, entityId); break;
    case 'ESTIMATE': allowed = await canAccessRow(req, 'Estimate', prisma.estimate, entityId); break;
    case 'JOB':      allowed = await canAccessRow(req, 'Job', prisma.job, entityId); break;
    case 'INVOICE':  allowed = await canAccessRow(req, 'Invoice', prisma.invoice, entityId); break;
    default:         allowed = false;
  }
  if (!allowed) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }
  return { ok: true };
}

/** Resolve a tag_id from the request body, either by id or by find-or-create-by-name. */
async function resolveTagId(
  req: Request,
  body: { tag_id?: string; name?: string; color?: string },
): Promise<
  { ok: true; tagId: string } | { ok: false; status: number; error: string; code?: string }
> {
  const orgId = req.user!.organization_id;
  let tagId: string | undefined = body.tag_id;

  if (tagId) {
    const tag = await prisma.tag.findFirst({
      where: { id: tagId, ...tenantWhere(req) },
    });
    if (!tag) {
      // The caller held a tag id that no longer resolves in this org - almost
      // always because an admin deleted the tag from Settings while this client
      // still had it in a cached picker list. `code` so the client can say so
      // precisely instead of matching on prose; a bare 404 on this route is
      // ambiguous between a missing tag and a missing record.
      return { ok: false, status: 404, error: 'Tag not found', code: 'TAG_NOT_FOUND' };
    }
  }

  if (!tagId && body.name) {
    const name = body.name;
    // Match ignoring case and reuse the existing tag ("vip" finds "VIP"): no 409 on this path (C-15).
    const resolved = await withTagNameLock(orgId, async (tx) => {
      const found = await findTagIgnoringCase(tx, orgId, name);
      if (found) return { tag: found } as const;
      // Minting a new tag name is the Create tags switch, whichever record route carried it (the lead creator
      // path opens the tag routes without it).
      if (!req.ability?.can('create', 'Tag')) return { forbidden: true } as const;
      const created = await tx.tag.create({
        data: { name, color: body.color || '#6B7280', organization_id: orgId },
      });
      return { tag: created } as const;
    });
    if ('forbidden' in resolved) {
      return { ok: false, status: 403, error: 'Insufficient permissions' };
    }
    tagId = resolved.tag.id;
  }

  if (!tagId) {
    return { ok: false, status: 400, error: 'Provide either tag_id or name' };
  }

  return { ok: true, tagId };
}

/** Attach a resolved tagId to an entity (409 result if already attached). */
async function attachTagAssignment(
  req: Request,
  entityType: TagEntityType,
  entityId: string,
  tagId: string,
): Promise<{ ok: true } | { ok: false; status: 409; error: string }> {
  const existingAssignment = await prisma.tagAssignment.findUnique({
    where: {
      tag_id_entity_type_entity_id: {
        tag_id: tagId,
        entity_type: entityType,
        entity_id: entityId,
      },
    },
  });
  if (existingAssignment) {
    return { ok: false, status: 409, error: `Tag already attached to this ${entityType.toLowerCase()}` };
  }

  try {
    await prisma.tagAssignment.create({
      data: {
        tag_id: tagId,
        entity_type: entityType,
        entity_id: entityId,
        organization_id: req.user!.organization_id,
      },
    });

    return { ok: true };
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Concurrent race condition: another in-flight request already attached this tag
      return { ok: true };
    }
    throw err;
  }
}

/**
 * PATCH /api/tags/:id — rename and/or recolour a tag org-wide.
 *
 * Edits the shared Tag row, so every record already carrying the tag shows the
 * new name/colour. ADMIN-only via `update Tag` (no default grant row).
 */
export async function update(req: Request, res: Response): Promise<void> {
  try {
    const id = param(req, 'id');
    // Already parsed by `updateTagSchema` on the route.
    const { name, color } = req.body as z.infer<typeof updateTagSchema>;

    // Scope by tenant first — prisma.tag.update() keys on the unique id alone and
    // would happily edit another org's row.
    const existing = await prisma.tag.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    const orgId = req.user!.organization_id;
    const outcome = await withTagNameLock(orgId, async (tx) => {
      if (name) {
        const clash = await findTagIgnoringCase(tx, orgId, name, id);
        if (clash) return { clash: true } as const;
      }
      const updated = await tx.tag.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(color !== undefined ? { color } : {}),
        },
        select: { id: true, name: true, color: true },
      });
      return { updated } as const;
    });
    if ('clash' in outcome) {
      res.status(409).json({ error: 'A tag with that name already exists' });
      return;
    }
    const tag = outcome.updated;

    res.json({ tag });
  } catch (err) {
    logger.error('Update tag error:', err);
    res.status(500).json({ error: 'Failed to update tag' });
  }
}

/**
 * DELETE /api/tags/:id — delete a tag org-wide.
 *
 * Destructive: the assignment rows cascade (schema onDelete: Cascade on both
 * tag_assignments and lead_tags), so the tag disappears from every customer,
 * lead, estimate, job and invoice carrying it. ADMIN-only via `delete Tag`.
 */
export async function remove(req: Request, res: Response): Promise<void> {
  try {
    const id = param(req, 'id');

    const existing = await prisma.tag.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Tag not found' });
      return;
    }

    await prisma.tag.delete({ where: { id } });

    res.status(204).send();
  } catch (err) {
    logger.error('Delete tag error:', err);
    res.status(500).json({ error: 'Failed to delete tag' });
  }
}

/**
 * Factory: build a handler that attaches a tag to a LEAD or JOB.
 * Mounted as POST /api/leads/:id/tags or POST /api/jobs/:id/tags.
 */
export function addTagToEntity(entityType: TagEntityType) {
  return async function handler(req: Request, res: Response): Promise<void> {
    try {
      const entityId = param(req, 'id');

      const entityCheck = await ensureEntityInOrg(req, entityType, entityId);
      if (!entityCheck.ok) {
        res.status(entityCheck.status).json({ error: entityCheck.error });
        return;
      }

      const scopeCheck = await ensureRowScopeAccess(req, entityType, entityId);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ error: scopeCheck.error });
        return;
      }

      const tagResult = await resolveTagId(req, req.body);
      if (!tagResult.ok) {
        res.status(tagResult.status).json({
          error: tagResult.error,
          ...(tagResult.code ? { code: tagResult.code } : {}),
        });
        return;
      }

      const attachResult = await attachTagAssignment(req, entityType, entityId, tagResult.tagId);
      if (!attachResult.ok) {
        res.status(attachResult.status).json({ error: attachResult.error });
        return;
      }

      const tag = await prisma.tag.findUnique({
        where: { id: tagResult.tagId },
        select: { id: true, name: true, color: true },
      });

      res.status(201).json({ tag });
    } catch (err) {
      logger.error(`Add tag to ${entityType.toLowerCase()} error:`, err);
      res.status(500).json({ error: `Failed to add tag to ${entityType.toLowerCase()}` });
    }
  };
}

/**
 * Factory: build a handler that bulk-attaches ONE tag to MANY entities of the same type.
 * Mounted as POST /api/customers/bulk-tag. Resolves the tag ONCE for the whole batch (so a new
 * `name` mints exactly one Tag row, not N racing tag.create calls against
 * @@unique(organization_id, name)), then loops ensureEntityInOrg + attachTagAssignment per id -
 * same order the single-row factory above uses.
 */
export function bulkAddTagToEntity(entityType: TagEntityType) {
  return async function handler(req: Request, res: Response): Promise<void> {
    try {
      const { ids, ...body } = req.body as { ids: string[]; tag_id?: string; name?: string; color?: string };

      const tagResult = await resolveTagId(req, body);
      if (!tagResult.ok) {
        res.status(tagResult.status).json({ error: tagResult.error });
        return;
      }

      const tagged: string[] = [];
      const failed: { id: string; error: string }[] = [];

      for (const entityId of ids) {
        try {
          const entityCheck = await ensureEntityInOrg(req, entityType, entityId);
          if (!entityCheck.ok) {
            failed.push({ id: entityId, error: entityCheck.error });
            continue;
          }

          // #2041 R5/AC13 — a rep keeps writing to every customer in the org without this: the
          // per-id `failed[]` message must read the SAME as a nonexistent id (both
          // `entityCheck.error` and this one are `'customer not found'`), so `failed[]` is not an
          // existence oracle.
          const scopeCheck = await ensureRowScopeAccess(req, entityType, entityId);
          if (!scopeCheck.ok) {
            failed.push({ id: entityId, error: scopeCheck.error });
            continue;
          }

          const attachResult = await attachTagAssignment(req, entityType, entityId, tagResult.tagId);
          if (!attachResult.ok) {
            failed.push({ id: entityId, error: attachResult.error });
            continue;
          }

          tagged.push(entityId);
        } catch (err) {
          logger.error(`Bulk add tag to ${entityType.toLowerCase()} error for ${entityId}:`, err);
          failed.push({ id: entityId, error: `Failed to add tag to ${entityType.toLowerCase()}` });
        }
      }

      const tag = await prisma.tag.findUnique({
        where: { id: tagResult.tagId },
        select: { id: true, name: true, color: true },
      });

      res.json({ tagged, failed, tag });
    } catch (err) {
      logger.error(`Bulk add tag to ${entityType.toLowerCase()} error:`, err);
      res.status(500).json({ error: `Failed to add tag to ${entityType.toLowerCase()}s` });
    }
  };
}

/**
 * Factory: build a handler that detaches a tag from a LEAD or JOB.
 * Mounted as DELETE /api/leads/:id/tags/:tagId or DELETE /api/jobs/:id/tags/:tagId.
 */
export function removeTagFromEntity(entityType: TagEntityType) {
  return async function handler(req: Request, res: Response): Promise<void> {
    try {
      const entityId = param(req, 'id');
      const tagId = param(req, 'tagId');
      const entityLabel = entityType.toLowerCase();

      const exists = await entityExistsInOrg(req, entityType, entityId);
      if (!exists) {
        res.status(404).json({ error: `${entityLabel} not found` });
        return;
      }

      const scopeCheck = await ensureRowScopeAccess(req, entityType, entityId);
      if (!scopeCheck.ok) {
        res.status(scopeCheck.status).json({ error: scopeCheck.error });
        return;
      }

      const assignment = await prisma.tagAssignment.findUnique({
        where: {
          tag_id_entity_type_entity_id: {
            tag_id: tagId,
            entity_type: entityType,
            entity_id: entityId,
          },
        },
      });
      if (!assignment) {
        // Same staleness as TAG_NOT_FOUND, seen from the other side: deleting a
        // tag cascades its assignment rows, so a chip rendered from a stale copy
        // of the record detaches into nothing.
        res.status(404).json({
          error: `Tag not attached to this ${entityLabel}`,
          code: 'TAG_NOT_ATTACHED',
        });
        return;
      }

      await prisma.tagAssignment.delete({
        where: {
          tag_id_entity_type_entity_id: {
            tag_id: tagId,
            entity_type: entityType,
            entity_id: entityId,
          },
        },
      });

      res.status(204).send();
    } catch (err) {
      logger.error(`Remove tag from ${entityType.toLowerCase()} error:`, err);
      res.status(500).json({ error: `Failed to remove tag from ${entityType.toLowerCase()}` });
    }
  };
}

// Route-named bindings (back-compat for existing imports).
export const addTagToLead = addTagToEntity('LEAD');
export const removeTagFromLead = removeTagFromEntity('LEAD');
export const addTagToJob = addTagToEntity('JOB');
export const removeTagFromJob = removeTagFromEntity('JOB');
export const addTagToCustomer = addTagToEntity('CUSTOMER');
export const removeTagFromCustomer = removeTagFromEntity('CUSTOMER');
export const bulkAddTagToCustomers = bulkAddTagToEntity('CUSTOMER');
export const addTagToEstimate = addTagToEntity('ESTIMATE');
export const removeTagFromEstimate = removeTagFromEntity('ESTIMATE');
export const addTagToInvoice = addTagToEntity('INVOICE');
export const removeTagFromInvoice = removeTagFromEntity('INVOICE');
