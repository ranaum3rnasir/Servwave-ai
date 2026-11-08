import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { normalizePhone } from '../lib/customer-duplicate';
import { validationFailure } from '../middleware/validate';

// ─── Zod Schemas ───────────────────────────────────────

// Purchasing Audit Verdict (2026-09-02, PR 1): ServWave never sends a PO, so a
// vendor's payment terms, default lead time and PO transmit method mean
// nothing here. The four legacy keys (`paymentTerms`, `leadTimeDays`,
// `transmitMethod`, `transmitMethods`) are deliberately ABSENT from both Zod
// schemas below: `validate()` replaces `req.body` with `schema.parse(body)`
// and a Zod object strips unknown keys, so an old client that still posts
// them is accepted and they are silently dropped - never a 400. PR 2's
// migration made the three columns nullable, so nothing writes them any more;
// dropping them is a later migration.

// #511: store vendor phones digits-only so comms-identity matchByPhone keeps
// resolving inbound calls/SMS. Lenient: no length refine (legacy free-text
// must not 400); blank/non-digit values clear to null.
const lenientVendorPhone = (v: string | null | undefined) =>
  v == null ? v : normalizePhone(v);

const vendorContactSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional().transform(lenientVendorPhone),
  role: z.string().max(200).optional(),
});

// Category (PR 4, S4.1): `categoryId` is the real reference (a row in
// vendor_categories; null = Uncategorized). The legacy `category` NAME is
// still accepted so an importer or an older client can send a name alone -
// it resolves to the existing row of that name or creates one. When both are
// present the id wins and the name is ignored for the write.
const categoryIdField = z.string().uuid().nullable().optional();
const categoryNameField = z.string().max(200).optional();

export const createVendorSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  categoryId: categoryIdField,
  category: categoryNameField,
  contactPersonName: z.string().max(200).nullable().optional(),
  contactEmail: z.string().max(200).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional().transform(lenientVendorPhone),
  additionalContacts: z.array(vendorContactSchema).optional(),
  accountNumber: z.string().max(100).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  pickupAddress: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

// The frontend upsert hook posts a Partial<Vendor>; when an `id` is present we
// update, otherwise we create. Everything is optional on the wire and the
// handler decides the path.
//
// `id` must be a real UUID: `vendors.id` is a Postgres UUID column, and the
// dialog stamps freshly-created vendors with a client-side placeholder id
// (`vnd_new_<timestamp>`) before the first save. Without this check that
// placeholder reaches `prisma.vendor.findFirst({ where: { id } })`, which
// throws on the malformed UUID (Prisma P2023) instead of failing validation —
// turning every "Add Vendor" save into an unhandled 500.
export const upsertVendorSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  categoryId: categoryIdField,
  category: categoryNameField,
  contactPersonName: z.string().max(200).nullable().optional(),
  contactEmail: z.string().max(200).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional().transform(lenientVendorPhone),
  additionalContacts: z.array(vendorContactSchema).optional(),
  accountNumber: z.string().max(100).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  pickupAddress: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});


// ─── Mapper: snake_case Prisma row → camelCase mock `Vendor` shape ─────────
//
// The frontend is typed against the `Vendor` mock type (camelCase keys, nested
// `additionalContacts`). The Prisma row uses snake_case columns + a `contacts`
// relation. This mapper bridges the two so the typed frontend works unchanged.

function mapContact(c: any) {
  const out: Record<string, unknown> = { id: c.id };
  if (c.name != null) out.name = c.name;
  if (c.email != null) out.email = c.email;
  if (c.phone != null) out.phone = c.phone;
  if (c.role != null) out.role = c.role;
  return out;
}

function toVendorDto(row: any) {
  // payment_terms / lead_time_days / transmit_method(s) are never emitted:
  // the row may still carry legacy values until the columns are dropped.
  // `category` is the linked row's name (the legacy string is kept in step on
  // every write, so it is the fallback when the relation was not loaded);
  // '' means Uncategorized. `categoryId` is always present so a client can
  // tell "no category" from "not yet migrated".
  const dto: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    category: row.category_rel?.name ?? row.category ?? '',
    categoryId: row.category_id ?? null,
  };

  if (row.contact_person_name != null) dto.contactPersonName = row.contact_person_name;
  if (row.contact_email != null) dto.contactEmail = row.contact_email;
  if (row.contact_phone != null) dto.contactPhone = row.contact_phone;
  if (Array.isArray(row.contacts) && row.contacts.length > 0) {
    dto.additionalContacts = row.contacts.map(mapContact);
  }
  if (row.account_number != null) dto.accountNumber = row.account_number;
  if (row.website != null) dto.website = row.website;
  if (row.pickup_address != null) dto.pickupAddress = row.pickup_address;
  if (row.notes != null) dto.notes = row.notes;
  if (row.status != null) dto.status = row.status;

  return dto;
}

// Translate the camelCase request body into a snake_case Prisma `data` object.
// Only keys present on the body are written so PATCH-style upserts don't clobber
// untouched columns.
function toVendorData(body: any) {
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  // `category` / `categoryId` are resolved by resolveCategoryData(), not copied.
  if (body.contactPersonName !== undefined) data.contact_person_name = body.contactPersonName;
  if (body.contactEmail !== undefined) data.contact_email = body.contactEmail;
  if (body.contactPhone !== undefined) data.contact_phone = body.contactPhone;
  if (body.accountNumber !== undefined) data.account_number = body.accountNumber;
  if (body.website !== undefined) data.website = body.website;
  if (body.pickupAddress !== undefined) data.pickup_address = body.pickupAddress;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.status !== undefined) data.status = body.status;
  return data;
}

const vendorInclude = { contacts: true, category_rel: true } as const;

type CategoryData = { category_id: string | null; category: string };

class CategoryNotFoundError extends Error {}

/**
 * Turn the body's category reference into the two columns a vendor row keeps:
 * the FK and the legacy display string, always written together so neither
 * can drift. `undefined` = the body said nothing about the category.
 *
 *   categoryId: null            -> Uncategorized
 *   categoryId: <uuid>          -> that row (must exist in the org, else 400)
 *   category: ''  (no id)       -> Uncategorized
 *   category: 'X' (no id)       -> the org's row named X, created if missing
 */
async function resolveCategoryData(req: Request, body: any): Promise<CategoryData | undefined> {
  const orgId = req.user!.organization_id;

  if (body.categoryId !== undefined) {
    if (body.categoryId === null) return { category_id: null, category: '' };
    const row = await prisma.vendorCategory.findFirst({
      where: { id: body.categoryId, organization_id: orgId },
    });
    if (!row) throw new CategoryNotFoundError();
    return { category_id: row.id, category: row.name };
  }

  if (body.category !== undefined) {
    const name = String(body.category).trim();
    if (!name) return { category_id: null, category: '' };
    const existing = await prisma.vendorCategory.findFirst({
      where: { organization_id: orgId, name: { equals: name, mode: 'insensitive' } },
    });
    const row = existing ?? await prisma.vendorCategory.create({
      data: { name, organization_id: orgId },
    });
    return { category_id: row.id, category: row.name };
  }

  return undefined;
}

function categoryNotFound(res: Response) {
  res.status(400).json(validationFailure([{ field: 'categoryId', message: 'Category not found' }]));
}

// ─── Handlers ──────────────────────────────────────────

export async function listVendors(req: Request, res: Response) {
  try {
    const vendors: any = await prisma.vendor.findMany({
      where: tenantWhere(req),
      orderBy: [{ name: 'asc' }],
      include: vendorInclude,
    });

    res.json({ vendors: vendors.map(toVendorDto) });
  } catch (err) {
    logger.error('Failed to list vendors:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getVendor(req: Request, res: Response) {
  try {
    const vendor: any = await prisma.vendor.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: vendorInclude,
    });

    if (!vendor) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }

    res.json({ vendor: toVendorDto(vendor) });
  } catch (err) {
    logger.error('Failed to get vendor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Single upsert endpoint backing the frontend `useUpsertVendor` hook. With an
// `id` it updates the matching tenant-scoped row; without one it creates.
export async function upsertVendor(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const contacts = Array.isArray(req.body.additionalContacts)
      ? req.body.additionalContacts
      : undefined;

    if (req.body.id) {
      const existing = await prisma.vendor.findFirst({
        where: { id: req.body.id, ...tenantWhere(req) },
      });
      if (!existing) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
      }

      let categoryData: CategoryData | undefined;
      try {
        categoryData = await resolveCategoryData(req, req.body);
      } catch (err) {
        if (err instanceof CategoryNotFoundError) { categoryNotFound(res); return; }
        throw err;
      }

      const vendor: any = await prisma.$transaction(async (tx) => {
        await tx.vendor.update({
          where: { id: req.body.id },
          data: { ...toVendorData(req.body), ...(categoryData ?? {}) },
        });

        // Replace the contact set when the caller sends one (the dialog always
        // sends the full list). Omitted → leave contacts untouched.
        if (contacts) {
          await tx.vendorContact.deleteMany({
            where: { vendor_id: req.body.id, ...tenantWhere(req) },
          });
          if (contacts.length > 0) {
            await tx.vendorContact.createMany({
              data: contacts.map((c: any) => ({
                vendor_id: req.body.id,
                name: c.name ?? null,
                email: c.email ?? null,
                phone: c.phone ?? null,
                role: c.role ?? null,
                organization_id: orgId,
              })),
            });
          }
        }

        return tx.vendor.findFirst({
          where: { id: req.body.id, ...tenantWhere(req) },
          include: vendorInclude,
        });
      });

      void logAudit({
        req,
        action: 'inventory.vendor_updated',
        resourceType: 'Vendor',
        resourceId: req.body.id,
        metadata: { fields: Object.keys(req.body) },
      });

      res.json({ vendor: toVendorDto(vendor) });
      return;
    }

    if (!req.body.name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    let createCategory: CategoryData | undefined;
    try {
      createCategory = await resolveCategoryData(req, req.body);
    } catch (err) {
      if (err instanceof CategoryNotFoundError) { categoryNotFound(res); return; }
      throw err;
    }

    const vendor: any = await prisma.vendor.create({
      data: {
        name: req.body.name,
        // Uncategorized unless the body named a category.
        category: createCategory?.category ?? '',
        category_id: createCategory?.category_id ?? null,
        contact_person_name: req.body.contactPersonName ?? null,
        contact_email: req.body.contactEmail ?? null,
        contact_phone: req.body.contactPhone ?? null,
        account_number: req.body.accountNumber ?? null,
        website: req.body.website ?? null,
        pickup_address: req.body.pickupAddress ?? null,
        notes: req.body.notes ?? null,
        status: req.body.status ?? 'active',
        organization_id: orgId,
        contacts: contacts && contacts.length > 0
          ? {
              create: contacts.map((c: any) => ({
                name: c.name ?? null,
                email: c.email ?? null,
                phone: c.phone ?? null,
                role: c.role ?? null,
                organization_id: orgId,
              })),
            }
          : undefined,
      },
      include: vendorInclude,
    });

    void logAudit({
      req,
      action: 'inventory.vendor_created',
      resourceType: 'Vendor',
      resourceId: vendor.id,
      metadata: { name: vendor.name },
    });

    res.status(201).json({ vendor: toVendorDto(vendor) });
  } catch (err) {
    logger.error('Failed to upsert vendor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// P2 item 7: canonical DELETE /vendors/:id with a has-POs guard (A-17, QA-610).
// "Archive" is NOT a new state: the existing upsert's status:'inactive' is the
// documented soft-archive flag (pickers already exclude it), so the 409 points
// the client at that toggle instead of a new endpoint.
export async function deleteVendor(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    // `:id` comes from the URL, not the Zod-validated body — a route param
    // never goes through `upsertVendorSchema`. It must still be a real UUID
    // before touching Prisma: `purchase_orders.vendor_id` and `vendors.id` are
    // both UUID columns, and the optimistically-inserted vendor row (added to
    // VendorsPage state before its create response returns) briefly carries
    // the same non-UUID placeholder id the upsert fix above guards against.
    if (!z.string().uuid().safeParse(id).success) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }

    // Guard keyed on the vendor_id FK: post-P2 POs carry it and legacy rows were
    // exact-name backfilled. Name-ambiguous legacy POs keep vendor_id NULL and do
    // not block — the PO retains its `vendor` display string via SetNull (QA-610).
    // Count-then-delete TOCTOU is acceptable for a human admin action (same
    // tolerance as stock set-quantity).
    const poCount = await prisma.purchaseOrder.count({
      where: { vendor_id: id, ...tenantWhere(req) },
    });
    if (poCount > 0) {
      res.status(409).json({
        error: 'VENDOR_HAS_POS',
        message: 'This vendor has purchase orders. Archive it instead.',
        po_count: poCount,
      });
      return;
    }

    // deleteMany with id+org filter is atomic — no TOCTOU window. Contacts
    // cascade via the FK onDelete: Cascade.
    const result = await prisma.vendor.deleteMany({
      where: { id, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }

    void logAudit({
      req,
      action: 'inventory.vendor_deleted',
      resourceType: 'Vendor',
      resourceId: id,
    });

    res.json({ message: 'Vendor deleted' });
  } catch (err) {
    logger.error('Failed to delete vendor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
