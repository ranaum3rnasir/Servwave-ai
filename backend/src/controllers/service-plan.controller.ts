import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { logger } from '../lib/logger';
import {
  derivePlanFields,
  bestFitCadence,
  describeRule,
  toRule,
  type VisitLike,
  type Cadence,
  type IntervalUnit,
} from '../lib/servicePlans/derive';
import { buildPlanInvoiceData } from '../lib/servicePlans/planInvoice';
import { instantiatePlanMaterials } from '../lib/logisticOrders';
// Creator tracking (audit only) - never read for authorization here.
import { CREATED_BY_SYSTEM } from '../lib/created-by';
import { resolveTaxRateForState } from '../lib/tax/resolveTaxRate';
import { createJobVisit, nextVisitSeqForJob } from '../services/walkthrough.service';
import { replaceVisitCrew } from '../services/visitCrew';
// The SAME per-member eligibility check the /jobs crew doors run. Imported rather than re-rolled
// so this door cannot drift from them on either the tenant clause or the error strings.
import { validateCrew } from './job.controller';

const param = (req: Request, name: string): string => req.params[name] as string;

const CADENCES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;
const INTERVAL_UNITS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;

const lineItemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

// Materials-template line (LO-5): a tracked-item pick + qty. Snapshots (sku/name) are resolved
// from the catalog at save; there is no location at template level (the per-visit LO editor fills
// it from the default chain at process time). qty is Decimal(10,2) — fractional allowed.
const materialLineSchema = z.object({
  item_id: z.string().uuid(),
  qty: z.number().positive(),
});

// Shared field set for create + update. visit_cadence is now OPTIONAL: a plan can be defined by the
// structured (Google-Calendar-style) recurrence fields instead, and the controller fills a best-fit
// visit_cadence so the legacy column + any old readers keep working.
const planObject = z.object({
  customer_id: z.string().uuid(),
  service_location_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  visit_cadence: z.enum(CADENCES).optional(),
  // Structured recurrence: "every <interval_count> <interval_unit>, on <byweekday>". byweekday is
  // 0–6 (0=Sun), only meaningful for WEEK. Terminators: end_date ("on date") + occurrence_count
  // ("after N visits"); omit both for an open-ended plan.
  interval_unit: z.enum(INTERVAL_UNITS).optional(),
  interval_count: z.number().int().positive().max(366).optional(),
  byweekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  occurrence_count: z.number().int().positive().max(10000).nullable().optional(),
  start_date: z.coerce.date(),
  // Optional / nullable: a plan may be open-ended ("runs forever" — no contract end). A null
  // end_date makes the card show "ongoing" with no finite visits-left (see derive.ts).
  end_date: z.coerce.date().nullable().optional(),
  contract_price: z.number().nonnegative(),
  line_items: z.array(lineItemSchema).default([]),
  // LO-5 materials template. Absent = don't touch on PATCH; [] = clear; [...] = full replace
  // (three-state semantics mirror line_items). Defaults to [] on create.
  material_lines: z.array(materialLineSchema).default([]),
  sold_by: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().nullable().optional(),
});

export const createPlanSchema = planObject
  .strict()
  .refine((d) => d.visit_cadence != null || d.interval_unit != null, {
    message: 'A recurrence is required: provide visit_cadence or interval_unit',
    path: ['visit_cadence'],
  });

// PATCH accepts any subset; the controller enforces the edit-lock (DRAFT = free, ACTIVE = name/sold_by only).
export const updatePlanSchema = planObject.partial().strip();

/** Shape of the recurrence inputs the controller reads off create/update bodies. */
type RecurrenceInput = {
  visit_cadence?: Cadence;
  interval_unit?: IntervalUnit;
  interval_count?: number;
  byweekday?: number[];
  occurrence_count?: number | null;
};

/**
 * Resolve the legacy visit_cadence column value from an input: an explicit enum wins, otherwise a
 * best-fit label is derived from the structured fields. Returns undefined when neither is present
 * (an update that doesn't touch the recurrence).
 */
function resolveCadence(input: RecurrenceInput): Cadence | undefined {
  if (input.visit_cadence) return input.visit_cadence;
  if (input.interval_unit) {
    return bestFitCadence({
      unit: input.interval_unit,
      count: input.interval_count ?? 1,
      byweekday: input.byweekday ?? [],
      end_date: null,
      occurrence_count: input.occurrence_count ?? null,
    });
  }
  return undefined;
}

export const scheduleVisitSchema = z
  .object({
    scheduled_start: z.coerce.date(),
    scheduled_end: z.coerce.date().nullable().optional(),
    assigned_to: z.string().uuid().nullable().optional(),
  })
  .strict();

// ─── Derived-field attachment ──────────────────────────────────────────────

type PlanWithVisits = {
  visit_cadence: (typeof CADENCES)[number];
  interval_unit?: (typeof INTERVAL_UNITS)[number] | null;
  interval_count?: number | null;
  byweekday?: number[] | null;
  occurrence_count?: number | null;
  start_date: Date;
  end_date: Date | null;
  status: 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  visits?: VisitLike[];
};

function attachDerived<T extends PlanWithVisits>(plan: T, now: Date) {
  const visits = (plan.visits ?? []) as VisitLike[];
  return { ...plan, ...derivePlanFields(plan, visits, now) };
}

const listInclude = {
  line_items: { orderBy: { position: 'asc' as const } },
  material_lines: { orderBy: { position: 'asc' as const } },
  visits: { select: { status: true, scheduled_date: true } },
  customer: { select: { id: true, company_name: true, first_name: true, last_name: true } },
  service_location: { select: { id: true, address_line1: true, city: true, state: true } },
};

// #1997 round 3 (MEDIUM) — this used to also project `public_token`, behind `read ServicePlan`
// only (no `read Customer` check anywhere on this route), so a requester whose `read Customer`
// is narrowed for the plan's own customer could recover the SAME invoice's token here even though
// `GET /api/invoices/:id` withholds it. No frontend reader consumes
// `plan.invoices[].public_token` (grepped `frontend/src/pages/v2/service-plans` and
// `frontend/src/pages/service-plans` — both print only `invoice_number`/`kind`/`total_amount`),
// so the key is dropped from the select outright rather than gated per-requester. Exported so the
// guard test (`service-plans.test.ts`) pins it never comes back.
export const planDetailInvoicesSelect = { id: true, invoice_number: true, kind: true, status: true, total_amount: true } as const;

const customerName = (c: { company_name: string | null; first_name: string | null; last_name: string | null }) =>
  c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer';

/**
 * Resolve item_id → sku/name snapshots for materials-template lines, org-scoped to TRACKED
 * inventory items (mirrors the LO add-time rule). Returns null when some item_id is not a tracked
 * in-org item (caller → 400); otherwise persist-ready rows carrying the position index. Runs on the
 * GLOBAL client — call it BEFORE opening a transaction (pool discipline, PR #859).
 */
async function snapshotMaterialLines(
  req: Request,
  orgId: string,
  materialLines: { item_id: string; qty: number }[],
): Promise<
  | { item_id: string; item_sku: string; item_name: string; qty: number; position: number }[]
  | null
> {
  if (materialLines.length === 0) return [];
  const itemIds = [...new Set(materialLines.map((l) => l.item_id))];
  const items = await prisma.priceBookItem.findMany({
    where: { id: { in: itemIds }, ...tenantWhere(req), track_inventory: true },
    select: { id: true, sku: true, name: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  if (itemIds.some((id) => !byId.has(id))) return null;
  return materialLines.map((l, i) => {
    const it = byId.get(l.item_id)!;
    return { item_id: l.item_id, item_sku: it.sku ?? '', item_name: it.name, qty: l.qty, position: i };
  });
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export const listPlans = async (req: Request, res: Response) => {
  try {
    const plans = await prisma.servicePlan.findMany({
      where: { ...tenantWhere(req) },
      orderBy: { created_at: 'desc' },
      include: listInclude,
    });
    const now = new Date();
    res.json({ servicePlans: plans.map((p) => attachDerived(p as never, now)) });
  } catch (err) {
    logger.error('listPlans error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createPlan = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof createPlanSchema>;
    const orgId = req.user!.organization_id;

    const customer = await prisma.customer.findUnique({
      where: { id: data.customer_id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const location = await prisma.serviceLocation.findFirst({
      where: { id: data.service_location_id, customer_id: data.customer_id, customer: tenantWhere(req) },
      select: { id: true },
    });
    if (!location) {
      res.status(404).json({ error: 'Service location not found or does not belong to customer' });
      return;
    }

    // Resolve the materials-template snapshots BEFORE the tx (pool-safe). null = some item is not a
    // tracked in-org item → 400 and nothing is created.
    const materialRows = await snapshotMaterialLines(req, orgId, data.material_lines);
    if (materialRows === null) {
      res.status(400).json({ error: 'One or more material items are not tracked inventory items in this organization' });
      return;
    }

    const plan = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const number = await allocateNumber(tx, 'service_plan', orgId);
      return tx.servicePlan.create({
        data: {
          service_plan_number: number,
          organization_id: orgId,
          customer_id: data.customer_id,
          service_location_id: data.service_location_id,
          name: data.name,
          // visit_cadence is always written (NOT NULL legacy column): the explicit enum or a
          // best-fit derived from the structured fields (the refine guarantees one is present).
          visit_cadence: resolveCadence(data) as Cadence,
          // Persist the structured recurrence only when supplied; a legacy create leaves these at
          // their column defaults (null / empty), and the engine falls back to visit_cadence.
          ...(data.interval_unit
            ? {
                interval_unit: data.interval_unit,
                interval_count: data.interval_count ?? 1,
                byweekday: data.byweekday ?? [],
                occurrence_count: data.occurrence_count ?? null,
              }
            : {}),
          start_date: data.start_date,
          end_date: data.end_date ?? null,
          contract_price: data.contract_price,
          sold_by: data.sold_by ?? null,
          template_id: data.template_id ?? null,
          line_items: {
            create: data.line_items.map((li, i) => ({
              name: li.name,
              quantity: li.quantity,
              unit_price: li.unit_price,
              position: i,
              organization_id: orgId,
            })),
          },
          material_lines: {
            create: materialRows.map((m) => ({
              item_id: m.item_id,
              item_sku: m.item_sku,
              item_name: m.item_name,
              qty: m.qty,
              position: m.position,
              organization_id: orgId,
            })),
          },
        },
        include: listInclude,
      });
    }), { label: 'service_plan.create' });

    res.status(201).json({ servicePlan: attachDerived(plan as never, new Date()) });
  } catch (err) {
    logger.error('createPlan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getPlan = async (req: Request, res: Response) => {
  try {
    const plan = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: {
        line_items: { orderBy: { position: 'asc' } },
        material_lines: { orderBy: { position: 'asc' } },
        visits: { orderBy: { visit_number: 'asc' }, include: { job: { select: { id: true, job_number: true, status: true, visits: { select: { assignees: { select: { user_id: true } } } } } } } },
        invoices: { select: planDetailInvoicesSelect },
        customer: { select: { id: true, company_name: true, first_name: true, last_name: true } },
        service_location: { select: { id: true, address_line1: true, city: true, state: true } },
      },
    });
    if (!plan) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }
    res.json({ servicePlan: attachDerived(plan as never, new Date()) });
  } catch (err) {
    logger.error('getPlan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updatePlan = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof updatePlanSchema>;
    const existing = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true,
        visit_cadence: true, interval_unit: true, interval_count: true, byweekday: true, occurrence_count: true,
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }

    if (existing.status !== 'DRAFT') {
      // Edit-lock: an active/expired/cancelled plan is tied to an invoice already sent —
      // billing-affecting fields (line_items, cadence, pricing) are frozen.
      //
      // Materials are the one exception: a Logistic Order is goods-issue only and never
      // touches invoice pricing, so a template revision here can't desync anything already
      // billed. They behave like a Job/Estimate line item — editable regardless of the
      // parent's lifecycle status. An edit here is a template revision that applies to
      // FUTURE scheduled visits only; instantiatePlanMaterials snapshots sku/name/qty onto
      // a minted LogisticOrderLine at schedule time with no live reference back to
      // ServicePlanMaterialLine, so an already-minted LO can never retro-change.
      const allowed = new Set(['name', 'sold_by', 'material_lines']);
      const disallowed = Object.keys(data).filter((k) => !allowed.has(k));
      if (disallowed.length > 0) {
        res.status(400).json({ error: `Only name, sold_by, and materials can be edited on a ${existing.status.toLowerCase()} plan` });
        return;
      }

      if (!data.material_lines) {
        // No materials in this request — keep the plain, non-transactional path (unchanged
        // from before this carve-out: a name/sold_by-only edit never needed a transaction).
        const updated = await prisma.servicePlan.update({
          where: { id: existing.id },
          data: { name: data.name, sold_by: data.sold_by ?? undefined },
          include: listInclude,
        });
        res.json({ servicePlan: attachDerived(updated as never, new Date()) });
        return;
      }

      // Materials present — resolve snapshots on the global client BEFORE the tx (pool
      // discipline), then full-replace inside one transaction alongside name/sold_by.
      const orgId = req.user!.organization_id;
      const resolved = await snapshotMaterialLines(req, orgId, data.material_lines);
      if (resolved === null) {
        res.status(400).json({ error: 'One or more material items are not tracked inventory items in this organization' });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.servicePlanMaterialLine.deleteMany({ where: { service_plan_id: existing.id } });
        await tx.servicePlanMaterialLine.createMany({
          data: resolved.map((m) => ({
            service_plan_id: existing.id,
            item_id: m.item_id,
            item_sku: m.item_sku,
            item_name: m.item_name,
            qty: m.qty,
            position: m.position,
            organization_id: orgId,
          })),
        });
        return tx.servicePlan.update({
          where: { id: existing.id },
          data: { name: data.name, sold_by: data.sold_by ?? undefined },
          include: listInclude,
        });
      });
      res.json({ servicePlan: attachDerived(updated as never, new Date()) });
      return;
    }

    // DRAFT — free edit, including a full line-item / materials replacement when provided.
    const { line_items, material_lines, ...scalars } = data;
    const orgId = req.user!.organization_id;

    // Resolve materials snapshots BEFORE the tx (pool-safe). undefined = don't touch; [] = clear;
    // [...] = replace. A null return = some item is not a tracked in-org item → 400.
    let materialRows: { item_id: string; item_sku: string; item_name: string; qty: number; position: number }[] = [];
    if (material_lines) {
      const resolved = await snapshotMaterialLines(req, orgId, material_lines);
      if (resolved === null) {
        res.status(400).json({ error: 'One or more material items are not tracked inventory items in this organization' });
        return;
      }
      materialRows = resolved;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (material_lines) {
        await tx.servicePlanMaterialLine.deleteMany({ where: { service_plan_id: existing.id } });
        await tx.servicePlanMaterialLine.createMany({
          data: materialRows.map((m) => ({
            service_plan_id: existing.id,
            item_id: m.item_id,
            item_sku: m.item_sku,
            item_name: m.item_name,
            qty: m.qty,
            position: m.position,
            organization_id: orgId,
          })),
        });
      }
      if (line_items) {
        await tx.servicePlanLineItem.deleteMany({ where: { service_plan_id: existing.id } });
        await tx.servicePlanLineItem.createMany({
          data: line_items.map((li, i) => ({
            service_plan_id: existing.id,
            name: li.name,
            quantity: li.quantity,
            unit_price: li.unit_price,
            position: i,
            organization_id: orgId,
          })),
        });
      }
      // Keep the legacy visit_cadence label in sync when a draft edit touches the recurrence.
      // Compute the best-fit from the MERGED state (patch over the stored row), not the patch alone,
      // so e.g. changing only interval_count still relabels using the stored unit.
      const touchesStructured =
        'interval_unit' in scalars || 'interval_count' in scalars || 'byweekday' in scalars || 'occurrence_count' in scalars;
      let recomputedCadence: Cadence | undefined;
      if (scalars.visit_cadence) {
        recomputedCadence = scalars.visit_cadence;
      } else if (touchesStructured) {
        const unit = scalars.interval_unit ?? existing.interval_unit ?? undefined;
        if (unit) {
          recomputedCadence = bestFitCadence({
            unit,
            count: scalars.interval_count ?? existing.interval_count ?? 1,
            byweekday: scalars.byweekday ?? existing.byweekday ?? [],
            end_date: null,
            occurrence_count: null,
          });
        }
      }
      return tx.servicePlan.update({
        where: { id: existing.id },
        data: {
          ...scalars,
          ...(recomputedCadence ? { visit_cadence: recomputedCadence } : {}),
          sold_by: 'sold_by' in scalars ? scalars.sold_by ?? null : undefined,
          template_id: 'template_id' in scalars ? scalars.template_id ?? null : undefined,
        },
        include: listInclude,
      });
    });
    res.json({ servicePlan: attachDerived(updated as never, new Date()) });
  } catch (err) {
    logger.error('updatePlan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deletePlan = async (req: Request, res: Response) => {
  try {
    const existing = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }
    if (existing.status !== 'DRAFT') {
      res.status(400).json({ error: 'Only a draft plan can be deleted' });
      return;
    }
    await prisma.servicePlan.deleteMany({ where: { id: existing.id, ...tenantWhere(req) } });
    res.status(204).send();
  } catch (err) {
    logger.error('deletePlan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/** Resolve the numeric tax rate for a plan: the service location's state rate, zeroed if exempt. */
async function resolveTaxRate(orgId: string, state: string, taxExempt: boolean): Promise<number> {
  if (taxExempt) return 0;
  return resolveTaxRateForState(prisma, orgId, state);
}

export const activatePlan = async (req: Request, res: Response) => {
  try {
    const orgId = req.user!.organization_id;
    const plan = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: {
        line_items: { orderBy: { position: 'asc' } },
        customer: { select: { tax_exempt: true } },
        service_location: { select: { state: true } },
      },
    });
    if (!plan) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }
    if (plan.status !== 'DRAFT') {
      res.status(400).json({ error: 'Only a draft plan can be activated' });
      return;
    }
    if (plan.end_date !== null && new Date(plan.end_date).getTime() <= new Date(plan.start_date).getTime()) {
      res.status(400).json({ error: 'End date must be after start date' });
      return;
    }
    if (plan.line_items.length === 0) {
      res.status(400).json({ error: 'A plan needs at least one line item to activate' });
      return;
    }
    if (Number(plan.contract_price) <= 0) {
      res.status(400).json({ error: 'Contract price must be greater than zero' });
      return;
    }

    const taxExempt = plan.customer.tax_exempt;
    const taxRate = await resolveTaxRate(orgId, plan.service_location.state, taxExempt);

    const result = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocateNumber(tx, 'invoice', orgId);
      const invoice = await tx.invoice.create({
        data: buildPlanInvoiceData({
          invoiceNumber,
          organizationId: orgId,
          customerId: plan.customer_id,
          servicePlanId: plan.id,
          publicToken: randomUUID(),
          lineItems: plan.line_items.map((li) => ({ name: li.name, quantity: Number(li.quantity), unit_price: Number(li.unit_price) })),
          taxRate,
          taxExempt,
        }),
      });
      const updated = await tx.servicePlan.update({
        where: { id: plan.id },
        data: { status: 'ACTIVE' },
        include: listInclude,
      });
      return { invoice, servicePlan: updated };
    }), { label: 'service_plan.invoice.create' });

    res.json({ servicePlan: attachDerived(result.servicePlan as never, new Date()), invoice: result.invoice });
  } catch (err) {
    logger.error('activatePlan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const renewPlan = async (req: Request, res: Response) => {
  try {
    const orgId = req.user!.organization_id;
    const plan = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: {
        line_items: { orderBy: { position: 'asc' } },
        customer: { select: { tax_exempt: true } },
        service_location: { select: { state: true } },
      },
    });
    if (!plan) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }
    if (plan.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Only an active plan can be renewed' });
      return;
    }
    if (plan.end_date === null) {
      res.status(400).json({ error: 'An open-ended plan (no end date) cannot be renewed' });
      return;
    }

    const oldStart = new Date(plan.start_date).getTime();
    const oldEnd = new Date(plan.end_date).getTime();
    const newStart = new Date(oldEnd);
    const newEnd = new Date(oldEnd + (oldEnd - oldStart));

    const taxExempt = plan.customer.tax_exempt;
    const taxRate = await resolveTaxRate(orgId, plan.service_location.state, taxExempt);

    const result = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocateNumber(tx, 'invoice', orgId);
      const invoice = await tx.invoice.create({
        data: buildPlanInvoiceData({
          invoiceNumber,
          organizationId: orgId,
          customerId: plan.customer_id,
          servicePlanId: plan.id,
          publicToken: randomUUID(),
          lineItems: plan.line_items.map((li) => ({ name: li.name, quantity: Number(li.quantity), unit_price: Number(li.unit_price) })),
          taxRate,
          taxExempt,
        }),
      });
      const updated = await tx.servicePlan.update({
        where: { id: plan.id },
        data: { start_date: newStart, end_date: newEnd, renewals_count: { increment: 1 }, status: 'ACTIVE' },
        include: listInclude,
      });
      return { invoice, servicePlan: updated };
    }), { label: 'service_plan.invoice.create' });

    res.json({ servicePlan: attachDerived(result.servicePlan as never, new Date()), invoice: result.invoice });
  } catch (err) {
    logger.error('renewPlan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const cancelPlan = async (req: Request, res: Response) => {
  try {
    const existing = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }
    if (existing.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Only an active plan can be cancelled' });
      return;
    }
    const updated = await prisma.servicePlan.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED' },
      include: listInclude,
    });
    res.json({ servicePlan: attachDerived(updated as never, new Date()) });
  } catch (err) {
    logger.error('cancelPlan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── Scheduling ────────────────────────────────────────────────────────────

export const scheduleVisit = async (req: Request, res: Response) => {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof scheduleVisitSchema>;
    const plan = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      // material_lines widen (pool-safe pre-tx read): instantiatePlanMaterials mints the visit's
      // materials LO from them inside the tx below, so they must be loaded now (no global query
      // may run once $transaction is open — PR #859).
      include: {
        visits: { select: { status: true, scheduled_date: true } },
        material_lines: { orderBy: { position: 'asc' } },
      },
    });
    if (!plan) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }
    if (plan.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Plan must be active to schedule a visit' });
      return;
    }
    const derived = derivePlanFields(plan as never, plan.visits as VisitLike[], new Date());
    // null = open-ended plan (no end date) → always has visits remaining; only a finite count blocks.
    if (derived.visits_remaining !== null && derived.visits_remaining <= 0) {
      res.status(400).json({ error: 'No visits remaining on this plan' });
      return;
    }

    // Eligibility + TENANCY on the assignee. `assigned_to` arrives as a bare uuid and used to go
    // straight onto the visit's assignee set below; `visit_assignees.user_id` is a plain FK to
    // `users.id`, so an id from another organization was accepted and the row stamped with THIS
    // org's `organization_id`. OWN_JOB is `{ visits: { some: { assignees: { some: { user_id } } } } }`,
    // so that foreign user then satisfied own-job scope on this org's job - a cross-tenant read
    // grant minted by an ordinary scheduling call. This also restores the invariant
    // replaceVisitCrew documents: its findMany/deleteMany are not tenant-filtered, and
    // are safe only because every caller has already tenant-checked what it is about to write.
    //
    // OUTSIDE the transaction for the two reasons the job side gives: an ineligible assignee must
    // leave nothing written, and validateCrew issues its own top-level tenant-scoped user reads
    // rather than tx ones (no global query may run once $transaction is open - PR #859).
    if (body.assigned_to) {
      const crew = await validateCrew(req, [body.assigned_to]);
      if (!crew.ok) {
        res.status(crew.status).json({ error: crew.error });
        return;
      }
    }

    const result = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const jobNumber = await allocateNumber(tx, 'job', orgId);
      const job = await tx.job.create({
        data: {
          job_number: jobNumber,
          organization_id: orgId,
          customer_id: plan.customer_id,
          service_location_id: plan.service_location_id,
          source_plan_id: plan.id,
          scope_notes: plan.name,
          // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - the real
          // visit is booked just below (createJobVisit), in the same transaction, and carries the
          // matching window; the wire keys are a computed projection off it.
          // Scheduler-redesign: status is the scheduling axis (SCHEDULED iff it has a
          // time); a plan visit always carries scheduled_start. Crew is NOT set here any more -
          // multi-visit S8 (D6) moved it onto a real job VISIT, booked just below.
          status: 'SCHEDULED',
          // Audit: a plan visit job is materialised from the plan's schedule, not authored by the
          // person who happened to press Schedule, so it is SYSTEM with no creator. The same
          // function is what the future auto-generation cron will call, where there is no user at all.
          ...CREATED_BY_SYSTEM,
        },
      });
      // Multi-visit S8 (D6/D5): the plan's trip is a real Visit, and the plan's technician goes
      // on IT. This is not tidiness - it is what closes the second orphan class the S8 migration
      // header names: a plan-assigned technician is neither the job's creator nor on any visit, so
      // with the crew relation gone and no trip booked, OWN_JOB would silently 403 them on a job
      // they are genuinely assigned to. createJobVisit is the existing twin, and it leaves
      // `lead_id` UNSET (never null) for D5's `visits_exactly_one_parent` CHECK.
      const visitStart = new Date(body.scheduled_start);
      const jobVisit = await createJobVisit(tx, {
        jobId: job.id,
        orgId,
        visitSeq: await nextVisitSeqForJob(tx, orgId, job.id),
        scheduledAt: visitStart,
        // Same 60-minute default /assign applies to an open-ended window, so the two doors onto a
        // trip cannot disagree about what "no end given" means.
        scheduledEnd: body.scheduled_end ? new Date(body.scheduled_end) : new Date(visitStart.getTime() + 60 * 60 * 1000),
        isAllDay: false,
      });
      if (body.assigned_to) {
        await replaceVisitCrew(tx, { visitId: jobVisit.id, orgId, userIds: [body.assigned_to] });
      }

      const occupied = await tx.planVisit.count({
        where: { service_plan_id: plan.id, status: { in: ['SCHEDULED', 'COMPLETED', 'SKIPPED'] } },
      });
      const visit = await tx.planVisit.create({
        data: {
          organization_id: orgId,
          service_plan_id: plan.id,
          job_id: job.id,
          visit_number: occupied + 1,
          scheduled_date: body.scheduled_start,
          status: 'SCHEDULED',
        },
      });
      // Materials template → ONE DRAFT LogisticOrder for this visit, minted inside THIS tx so it
      // rolls back with the job + visit if anything below fails (spec §15). A plan with no material
      // lines mints nothing. The future auto-generation cron calls the same function.
      const logistic_order = await instantiatePlanMaterials(tx, plan, job, req.user!.id);
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB',
          entity_id: job.id,
          event_type: 'CREATED',
          description: `Plan visit for ${plan.service_plan_number} — Job ${job.job_number} created`,
          created_by: req.user!.id,
        },
      });
      return { job, visit, logistic_order };
    }), { label: 'service_plan.job.create' });

    res.status(201).json(result);
  } catch (err) {
    logger.error('scheduleVisit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const skipVisit = async (req: Request, res: Response) => {
  try {
    const orgId = req.user!.organization_id;
    const plan = await prisma.servicePlan.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: { visits: { select: { status: true, scheduled_date: true } } },
    });
    if (!plan) {
      res.status(404).json({ error: 'Service plan not found' });
      return;
    }
    if (plan.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Plan must be active to skip a visit' });
      return;
    }
    const derived = derivePlanFields(plan as never, plan.visits as VisitLike[], new Date());
    // null = open-ended plan (no end date) → always has visits remaining; only a finite count blocks.
    if (derived.visits_remaining !== null && derived.visits_remaining <= 0) {
      res.status(400).json({ error: 'No visits remaining on this plan' });
      return;
    }
    const occupied = await prisma.planVisit.count({
      where: { service_plan_id: plan.id, status: { in: ['SCHEDULED', 'COMPLETED', 'SKIPPED'] } },
    });
    const visit = await prisma.planVisit.create({
      data: {
        organization_id: orgId,
        service_plan_id: plan.id,
        job_id: null,
        visit_number: occupied + 1,
        scheduled_date: derived.next_due,
        status: 'SKIPPED',
      },
    });
    res.status(201).json({ visit });
  } catch (err) {
    logger.error('skipVisit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── Scheduler bucket feed ─────────────────────────────────────────────────

export const schedulerBucket = async (req: Request, res: Response) => {
  try {
    const plans = await prisma.servicePlan.findMany({
      where: { status: 'ACTIVE', ...tenantWhere(req) },
      include: {
        visits: { select: { status: true, scheduled_date: true } },
        customer: { select: { company_name: true, first_name: true, last_name: true } },
        service_location: { select: { city: true, state: true, address_line1: true } },
      },
    });
    const now = new Date();
    const bucket = plans
      .map((p) => ({ p, d: derivePlanFields(p as never, p.visits as VisitLike[], now) }))
      // Open-ended plans (null remaining) always belong in the bucket; finite plans need >0 left.
      .filter((x) => x.d.visits_remaining === null || x.d.visits_remaining > 0)
      .map(({ p, d }) => ({
        id: p.id,
        service_plan_number: p.service_plan_number,
        customer: customerName(p.customer),
        service_location: {
          address_line1: p.service_location.address_line1,
          city: p.service_location.city,
          state: p.service_location.state,
        },
        recurrence: describeRule(toRule(p as never)),
        next_due: d.next_due,
        visits_remaining: d.visits_remaining,
        due_soon: d.due_soon,
        overdue: d.overdue,
      }));
    res.json({ plans: bucket });
  } catch (err) {
    logger.error('schedulerBucket error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
