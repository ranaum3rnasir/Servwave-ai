import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import {
  BUILT_IN_LOST_REASONS,
  BUILT_IN_LOST_REASON_CODES,
  LOST_REASON_CODE_PATTERN,
  LOST_REASON_LABEL_MAX,
  MAX_LOST_REASON_OPTIONS,
  UNDEACTIVATABLE_LOST_REASON_CODE,
  deriveLostReasonCode,
} from '../lib/lostReasonOptions';

/**
 * The per-org estimate decline reason list (decline-reasons slice B).
 *
 * Structurally a jobSubStatus.controller.ts sibling, and it borrows from it a user-created
 * catalog of unbounded rows, with tenantWhere(req) spread on every Prisma call, READS AND WRITES
 * BOTH - the neighbouring controllers that write `update({ where: { id } })` unscoped after a
 * scoped read are deliberately not copied, because the multi-tenancy boundary is unconditional.
 * Unlike jobSubStatus, its rows start out as built-ins the org has never customised, addressed
 * by their STABLE KEY rather than by a row id.
 *
 * WHY THE WRITES ARE KEYED ON `code` AND NOT ON `id`. An organisation that has never opened this
 * screen has NO ROWS (decision D3) - it resolves to the five built-ins, which have no id to
 * PATCH. Keying on the id would force the client to "materialise" the list through some extra
 * call before its first rename, and would leave that call reachable on its own. Keying on the
 * code makes the first rename the materialisation, which is exactly what D3 describes, and the
 * code is unique per org so it addresses one row and never two. It is also the value
 * `estimates.lost_reason` already stores, so it is the identifier the rest of the product
 * already speaks.
 *
 * MATERIALISATION IS ALL FIVE OR NONE. The resolve rule is "the org's rows if it has any, else
 * the built-ins", so writing ONE row for a single rename would leave the org with a
 * one-item list and four built-ins silently gone. Every write path therefore writes all five
 * first, in the same transaction, and only when the org has none.
 *
 * NOTHING IS DELETED (D4/D5). A code is deactivated instead: declined estimates already hold it
 * and the conversion report groups on it, so deleting the row would turn readable history into
 * an orphan string. "Other" cannot even be deactivated - it is where the free-text comment
 * belongs. Consequently this controller has no DELETE handler at all, by design and not by
 * omission.
 */

// ─── Schemas ────────────────────────────────────────────────────────────────

/**
 * The label cap is enforced AFTER trimming, not before: `z.string().min(1).max(60)` accepts
 * sixty spaces and then trims them to the empty string, which is how a blank row gets into a
 * list that is validated at both ends. `.trim()` runs first here so `min(1)` sees the real value.
 */
const labelSchema = z.string().trim().min(1).max(LOST_REASON_LABEL_MAX);

const codeSchema = z.string().regex(LOST_REASON_CODE_PATTERN);

export const createLostReasonOptionSchema = z
  .object({
    label: labelSchema,
  })
  .strict();

export const updateLostReasonOptionSchema = z
  .object({
    label: labelSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  // An empty body is a request that means nothing; answering 200 to it would report a rename
  // that never happened.
  .refine((d) => d.label !== undefined || d.is_active !== undefined, {
    message: 'Send a label, an is_active, or both',
  });

export const reorderLostReasonOptionsSchema = z
  .object({
    ordered_codes: z
      .array(codeSchema)
      .min(1)
      .max(MAX_LOST_REASON_OPTIONS)
      .refine((arr) => new Set(arr).size === arr.length, { message: 'Duplicate code in reorder list' }),
  })
  .strict();

// ─── Shapes ─────────────────────────────────────────────────────────────────

interface LostReasonOptionDto {
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  /** Derived from the code, never stored - see the header note on schema.prisma's model. */
  is_builtin: boolean;
}

/**
 * The row's id is deliberately NOT in the response.
 *
 * Half the list this endpoint can return has no id at all (an org with no stored rows reads the
 * built-ins), so a client that keyed on the id would work for one org and break for the next.
 * Leaving it out makes that impossible to get wrong, and `code` is a perfectly good React key:
 * it is unique per org by the DB's own constraint.
 */
function toDto(row: { code: string; label: string; is_active: boolean; sort_order: number }): LostReasonOptionDto {
  return {
    code: row.code,
    label: row.label,
    is_active: row.is_active,
    sort_order: row.sort_order,
    is_builtin: BUILT_IN_LOST_REASON_CODES.has(row.code),
  };
}

/** The answer for an organisation that has never saved: the five built-ins, all active (D3). */
function builtInDtos(): LostReasonOptionDto[] {
  return BUILT_IN_LOST_REASONS.map((r, i) => toDto({ ...r, is_active: true, sort_order: i }));
}

/**
 * Stated once because create() reports the same collision from two places - its pre-check and
 * its P2002 backstop - and the admin who double-clicked Add must not be able to tell which of
 * the two answered. Rendered copy: it reaches the UI through `extractApiError`.
 */
const DUPLICATE_REASON_MSG = 'That decline reason already exists';

// ─── Materialisation ────────────────────────────────────────────────────────

/**
 * Write the five built-ins as real rows. Only ever called inside a write's transaction, and only
 * when the organisation has none of its own (D3).
 */
async function materialiseBuiltIns(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.lostReasonOption.createMany({
    data: BUILT_IN_LOST_REASONS.map((r, i) => ({
      organization_id: orgId,
      code: r.code,
      label: r.label,
      sort_order: i,
    })),
    // Two admins saving at the same moment both arrive here with a count of zero. The compound
    // unique key (organization_id, code) turns the loser's insert into a skip rather than a 500
    // and a doubled list, so the race resolves to the right five rows either way.
    skipDuplicates: true,
  });
}

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/**
 * GET /api/lost-reason-options - this org's list, or the built-ins if it has never saved one.
 *
 * INACTIVE ROWS ARE INCLUDED. This is the management view: an admin who deactivated a reason has
 * to be able to see it in order to switch it back on, the same way Settings > Tax Rates lists a
 * hidden rate. The pickers are the surface that filters on `is_active`, and they are slice C.
 */
export async function list(req: Request, res: Response) {
  try {
    const rows = await prisma.lostReasonOption.findMany({
      where: tenantWhere(req),
      // `code` is the tie-break rather than `label`, because sort_order is not unique and two
      // rows that tie must still come back in a STABLE order - a list that reshuffles between
      // two identical GETs makes a drag-to-reorder screen jump under the admin's hand.
      orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
    });
    res.json({ lost_reason_options: rows.length > 0 ? rows.map(toDto) : builtInDtos() });
  } catch (err) {
    logger.error('List lost reason options error:', err);
    res.status(500).json({ error: 'Failed to list decline reasons' });
  }
}

/** POST /api/lost-reason-options - add a reason of this organisation's own. */
export async function create(req: Request, res: Response) {
  try {
    const { label } = req.body as z.infer<typeof createLostReasonOptionSchema>;
    const orgId = req.user!.organization_id;

    const code = deriveLostReasonCode(label);
    if (!code) {
      res.status(400).json({ error: 'Give this reason a name with at least one letter or number' });
      return;
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const stored = await tx.lostReasonOption.count({ where: { organization_id: orgId } });
      if (stored === 0) {
        // A refused request must write nothing, here as much as in update() and reorder(): an
        // organisation that tried to re-add a reason it already has should not be left
        // materialised by the attempt. The org resolves to the built-ins, so a colliding code
        // is knowable before anything is written.
        if (BUILT_IN_LOST_REASON_CODES.has(code)) return { kind: 'duplicate' as const };
        await materialiseBuiltIns(tx, orgId);
      }

      // Re-counted rather than reusing `stored`: after materialisation the list is five long,
      // and both the cap and the append index have to be measured against what is actually
      // there now.
      const current = await tx.lostReasonOption.count({ where: { organization_id: orgId } });
      if (current >= MAX_LOST_REASON_OPTIONS) return { kind: 'full' as const };

      const collision = await tx.lostReasonOption.findFirst({ where: { code, organization_id: orgId } });
      // Never an upsert on the compound unique key with a user-supplied value: pre-checking and
      // 409-ing means a crafted body can never resolve a row, and a deactivated reason with the
      // same name is reported rather than silently revived under a new label.
      if (collision) return { kind: 'duplicate' as const };

      const row = await tx.lostReasonOption.create({
        data: {
          code,
          label,
          sort_order: current,
          // From the authenticated user, NEVER from the body.
          organization_id: orgId,
        },
      });
      return { kind: 'created' as const, row };
    });

    if (outcome.kind === 'full') {
      res.status(400).json({ error: `A decline reason list is capped at ${MAX_LOST_REASON_OPTIONS} reasons` });
      return;
    }
    if (outcome.kind === 'duplicate') {
      res.status(409).json({ error: DUPLICATE_REASON_MSG });
      return;
    }

    void logAudit({
      req,
      action: 'estimate.decline_reason_created',
      resourceType: 'LostReasonOption',
      resourceId: outcome.row.id,
      metadata: { code },
    });

    res.status(201).json({ lost_reason_option: toDto(outcome.row) });
  } catch (err) {
    // The pre-check and the insert share a transaction, which is NOT enough on its own: under
    // READ COMMITTED two requests that arrive together both read "no collision" in their own
    // snapshot and both insert, and the loser comes back P2002 on (organization_id, code). The
    // transaction makes that write atomic, not serialisable. A double-click on Add is the
    // everyday way to produce it, so it is answered with the SAME 409 the pre-check gives
    // rather than falling through to the generic 500 below - the request lost a race, the
    // server did not fault, and the admin's list already holds the reason they asked for.
    //
    // Unnarrowed on purpose: `@@unique([organization_id, code])` is the only unique key on this
    // model bar the primary key, so a P2002 here can mean nothing else.
    const prismaErr = err as { code?: string };
    if (prismaErr.code === 'P2002') {
      res.status(409).json({ error: DUPLICATE_REASON_MSG });
      return;
    }
    logger.error('Create lost reason option error:', err);
    res.status(500).json({ error: 'Failed to add decline reason' });
  }
}

/**
 * PATCH /api/lost-reason-options/:code - rename, deactivate, or restore.
 *
 * The code itself is immutable: `estimates.lost_reason` stores it and the conversion report
 * groups on it, so changing it would re-bucket history that has already been reported on. Only
 * the label - the words - is renameable.
 */
export async function update(req: Request, res: Response) {
  try {
    const code = param(req, 'code');
    if (!LOST_REASON_CODE_PATTERN.test(code)) {
      res.status(404).json({ error: 'Decline reason not found' });
      return;
    }
    const { label, is_active } = req.body as z.infer<typeof updateLostReasonOptionSchema>;
    const orgId = req.user!.organization_id;

    // D5. Checked before anything is read or written, so a request to switch "Other" off cannot
    // materialise the list as a side effect of being refused.
    if (is_active === false && code === UNDEACTIVATABLE_LOST_REASON_CODE) {
      // Plain ASCII: this string reaches the UI through extractApiError, so it is rendered copy
      // and not a log line.
      res.status(400).json({
        error: 'This reason has to stay available - it is where a customer writes their own wording',
      });
      return;
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const stored = await tx.lostReasonOption.count({ where: { organization_id: orgId } });
      if (stored === 0) {
        // The org resolves to the built-ins, so a code that is not one of them addresses
        // nothing. Answered BEFORE materialising: a 404 must not leave five rows behind it.
        if (!BUILT_IN_LOST_REASON_CODES.has(code)) return { kind: 'missing' as const };
        await materialiseBuiltIns(tx, orgId);
      }

      const data: { label?: string; is_active?: boolean } = {};
      if (label !== undefined) data.label = label;
      if (is_active !== undefined) data.is_active = is_active;

      // updateMany, not update: the tenant clause belongs in the WRITE's own where, not only in
      // a read that preceded it, and `count === 0` is then the 404 rather than a thrown P2025.
      const result = await tx.lostReasonOption.updateMany({ where: { code, organization_id: orgId }, data });
      if (result.count === 0) return { kind: 'missing' as const };

      const row = await tx.lostReasonOption.findFirst({ where: { code, organization_id: orgId } });
      return { kind: 'updated' as const, row };
    });

    if (outcome.kind === 'missing' || !outcome.row) {
      res.status(404).json({ error: 'Decline reason not found' });
      return;
    }

    void logAudit({
      req,
      action: 'estimate.decline_reason_updated',
      resourceType: 'LostReasonOption',
      resourceId: outcome.row.id,
      metadata: { code, ...(label !== undefined ? { label } : {}), ...(is_active !== undefined ? { is_active } : {}) },
    });

    res.json({ lost_reason_option: toDto(outcome.row) });
  } catch (err) {
    logger.error('Update lost reason option error:', err);
    res.status(500).json({ error: 'Failed to update decline reason' });
  }
}

/**
 * POST /api/lost-reason-options/reorder - rewrite sort_order for the whole list.
 *
 * Every supplied code has to resolve inside this org before anything is written, so a body
 * carrying one foreign or invented code writes NOTHING rather than reordering the rest around it.
 *
 * "The whole list" is literal and enforced: the body must name EVERY reason the org resolves to,
 * exactly once, or the request is refused whole. A partial list is not a partial reorder here -
 * it is a list with colliding sort_orders. See the check itself for why.
 */
export async function reorder(req: Request, res: Response) {
  try {
    const { ordered_codes } = req.body as z.infer<typeof reorderLostReasonOptionsSchema>;
    const orgId = req.user!.organization_id;

    const outcome = await prisma.$transaction(async (tx) => {
      const stored = await tx.lostReasonOption.count({ where: { organization_id: orgId } });

      // THE WHOLE LIST OR NOTHING. sort_order is assigned from the array index, so a body naming
      // only some of the org's reasons renumbers those from 0 and leaves every unnamed row on
      // the sort_order it already had - two rows then share a position, and where they land
      // relative to each other falls to list()'s `code` tie-break instead of to what the admin
      // dragged. Membership and uniqueness were already checked (here and in the schema); this
      // is the third of the three, and without it the endpoint silently half-applies.
      //
      // Measured against the RESOLVED list - the org's own rows, or the built-ins it still reads
      // as - and answered BEFORE materialising, for the same reason the two refusals below are:
      // a rejected reorder must leave the organisation exactly as unconfigured as it was.
      const total = stored === 0 ? BUILT_IN_LOST_REASON_CODES.size : stored;
      if (ordered_codes.length !== total) return { kind: 'incomplete' as const, total };

      if (stored === 0) {
        // Same rule as update(): refuse before materialising, so a rejected reorder leaves the
        // organisation exactly as unconfigured as it was.
        if (!ordered_codes.every((c) => BUILT_IN_LOST_REASON_CODES.has(c))) return { kind: 'unknown' as const };
        await materialiseBuiltIns(tx, orgId);
      }

      // One resolving read catches foreign-org codes and invented codes together.
      const found = await tx.lostReasonOption.findMany({
        where: { code: { in: ordered_codes }, organization_id: orgId },
        select: { code: true },
      });
      if (found.length !== ordered_codes.length) return { kind: 'unknown' as const };

      for (const [i, code] of ordered_codes.entries()) {
        await tx.lostReasonOption.updateMany({
          where: { code, organization_id: orgId },
          data: { sort_order: i },
        });
      }
      return { kind: 'reordered' as const };
    });

    if (outcome.kind === 'incomplete') {
      res.status(400).json({
        error: `Send all ${outcome.total} decline reasons when reordering, in the order you want them offered in`,
      });
      return;
    }
    if (outcome.kind === 'unknown') {
      res.status(400).json({ error: 'Unknown decline reason in reorder' });
      return;
    }

    void logAudit({
      req,
      action: 'estimate.decline_reasons_reordered',
      resourceType: 'LostReasonOption',
      metadata: { ordered_codes },
    });

    res.status(204).send();
  } catch (err) {
    logger.error('Reorder lost reason options error:', err);
    res.status(500).json({ error: 'Failed to reorder decline reasons' });
  }
}
