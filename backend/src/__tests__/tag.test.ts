import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS, mockAuthAs, authHeader,
  CUSTOMER_FIXTURE, ESTIMATE_FIXTURE, INVOICE_FIXTURE, TAG_FIXTURE, JOB_FIXTURE, LEAD_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const mockPrisma = prisma as unknown as {
  customer: { findFirst: ReturnType<typeof vi.fn> };
  estimate: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn> };
  lead: { findFirst: ReturnType<typeof vi.fn> };
  tag: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  tagAssignment: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockPrisma.tag.findFirst.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });
  mockPrisma.tag.findUnique.mockResolvedValue({ id: TAG_FIXTURE.id, name: 'Urgent', color: '#EF4444' });
  mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
  mockPrisma.tagAssignment.create.mockResolvedValue({ tag_id: TAG_FIXTURE.id });
  mockPrisma.tagAssignment.delete.mockResolvedValue({});
});

describe('POST /api/customers/:id/tags', () => {
  it('attaches an existing tag to a customer by tag_id (201)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(res.body.tag.name).toBe('Urgent');
    const args = mockPrisma.tagAssignment.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('CUSTOMER');
    expect(args.data.entity_id).toBe(CUSTOMER_FIXTURE.id);
  });

  it('returns 404 when the customer does not exist', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(404);
  });

  // SRVW-105 step 12 - the entity-existence check must run BEFORE the tag resolve/find-or-create,
  // exactly as it does today (tag.controller.ts entityExistsInOrg runs first). A two-way split that
  // resolved the tag first would CREATE a Tag row before 404ing on a nonexistent customer - a new
  // write on a 404 path. tag.test.ts's existing 404 case above asserts only the status code and
  // would stay green if that reorder happened; this locks the order through the refactor.
  it('404s on an unknown customer WITHOUT creating a tag', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ name: 'New' });

    expect(res.status).toBe(404);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
    expect(mockPrisma.tag.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /api/estimates/:id/tags', () => {
  it('attaches a tag to an estimate (201)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_FIXTURE.id });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
    const args = mockPrisma.tagAssignment.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('ESTIMATE');
  });
});

describe('POST /api/invoices/:id/tags', () => {
  it('attaches a tag to an invoice (201)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: INVOICE_FIXTURE.id });

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
    const args = mockPrisma.tagAssignment.create.mock.calls[0][0];
    expect(args.data.entity_type).toBe('INVOICE');
  });
});

// ─── Row-scope gate (tag row-scope fix, 2026-08-05) ─────────────────────────
// canDo('update', subject) is SUBJECT-level (no row loaded), so it cannot evaluate a row
// condition like OWN_JOB - it passes for every row once the role holds the bare grant.
// entityExistsInOrg only checks org tenancy. Net effect before this fix: a technician who can
// `update Job` (an unconditional role default) could tag ANY job in the org, not just one it's
// assigned to or created - despite read/delete/assign/manage_lines on the same subject all being
// properly row-scoped. These tests pin the fix: a per-instance canAccessRow gate, keyed off the
// subject's READ scope (mirrors job.controller.ts's own update/delete pattern), applied after the
// existing existence check and before the tag mutation. CUSTOMER is excluded - it has no
// ScopeResource / row-scoping concept anywhere in the codebase to be inconsistent with.

// JOB_FIXTURE.id is the suite-wide `j0000000-…` sentinel, and `j` is not a hex digit, so it is
// not a valid UUID at all (estimates.test.ts and logistic-orders.test.ts each note the same thing
// and work around it locally). Against the mocked client that never mattered; against Postgres a
// `jobs.id = 'j0000000-…'` lookup is the very P2023 the new route guard exists to prevent. These
// row-scope tests are about CASL, not id syntax, so they use a well-formed id - the job row is
// mocked either way, the value only has to parse.
const SCOPED_JOB_ID = 'ab000000-0000-0000-0000-000000000001';

describe('POST /api/jobs/:id/tags - row-scope gate', () => {
  it('403s a TECHNICIAN neither assigned to nor the creator of the job', async () => {
    mockAuthAs('technician');
    // entityExistsInOrg's tenant-only probe finds the row; canAccessRow's SCOPED probe (its
    // `where` carries the OWN_OR_CREATED_JOB `OR`) finds nothing - the technician has no claim.
    mockPrisma.job.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: SCOPED_JOB_ID }));

    const res = await request(app)
      .post(`/api/jobs/${SCOPED_JOB_ID}/tags`)
      .set(authHeader('technician'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });

  it('allows a TECHNICIAN whose scope matches the job (201)', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findFirst.mockResolvedValue({ id: SCOPED_JOB_ID });

    const res = await request(app)
      .post(`/api/jobs/${SCOPED_JOB_ID}/tags`)
      .set(authHeader('technician'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/jobs/:id/tags/:tagId - row-scope gate', () => {
  it('403s a TECHNICIAN neither assigned to nor the creator of the job', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: SCOPED_JOB_ID }));
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/jobs/${SCOPED_JOB_ID}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/leads/:id/tags - row-scope gate', () => {
  it('403s a SALES rep not assigned to the lead', async () => {
    mockAuthAs('sales');
    // OWN_LEAD's scoped probe carries `lead_assignees`; the tenant-only existence probe doesn't.
    mockPrisma.lead.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.lead_assignees ? null : { id: LEAD_FIXTURE.id }));

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });

  it('allows a SALES rep assigned to the lead (201)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/leads/:id/tags/:tagId - row-scope gate', () => {
  it('403s a SALES rep not assigned to the lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.lead_assignees ? null : { id: LEAD_FIXTURE.id }));
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/estimates/:id/tags - row-scope gate', () => {
  it('403s a SALES rep who cannot READ this estimate, even though update Estimate is unconditional', async () => {
    mockAuthAs('sales');
    // SALES's `update Estimate` grant is unconditional (defaultGrants.ts) - the OLD subject-level
    // canDo guard alone would let this through. Its `read Estimate` grant
    // (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR) is conditional, and canAccessRow keys off READ, not
    // update - matching how estimate.controller.ts's own mutation handlers already gate via
    // canAccessEstimate despite the same unconditional route-level grant.
    mockPrisma.estimate.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: ESTIMATE_FIXTURE.id }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/estimates/:id/tags/:tagId - row-scope gate', () => {
  it('403s a SALES rep who cannot READ this estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.OR ? null : { id: ESTIMATE_FIXTURE.id }));
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/estimates/${ESTIMATE_FIXTURE.id}/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/invoices/:id/tags - row-scope gate', () => {
  // No DEFAULT role today holds BOTH a conditional `read Invoice` and `update Invoice` grant
  // (DISPATCHER/ADMIN, the only roles with `update Invoice`, both read Invoice unconditionally) -
  // so there is no realistic default-role 403 to exercise here. This proves the MECHANISM is
  // correctly wired for Invoice too (not skipped), for the day a per-user override or a future
  // role narrows `read Invoice` to conditional while keeping `update Invoice`.
  it('403s a DISPATCHER whose read Invoice grant is narrowed to conditional and does not match this invoice', async () => {
    mockAuthAs('dispatcher');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && !(g.action === 'read' && g.subject === 'Invoice')),
      { role: 'DISPATCHER', action: 'read', subject: 'Invoice', conditions: { job: { assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
    mockPrisma.invoice.findFirst.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve(args.where.job ? null : { id: INVOICE_FIXTURE.id }));

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/tags`)
      .set(authHeader('dispatcher'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(403);
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });
});

// ─── POST /api/customers/bulk-tag ───────────────────────
// Exercises bulkAddTagToCustomers(), which resolves the tag ONCE for the whole batch (so a new
// `name` mints exactly one Tag row, not N racing creates against @@unique(organization_id, name)),
// then loops ensureEntityInOrg + attachTagAssignment per id - same order the single-row factory
// (addTagToEntity) uses.
describe('POST /api/customers/bulk-tag', () => {
  const CUST_A = 'd1000000-0000-0000-0000-000000000001';
  const CUST_B = 'd1000000-0000-0000-0000-000000000002';
  const CUST_C = 'd1000000-0000-0000-0000-000000000003';
  const TAGGED_ID = 'd1000000-0000-0000-0000-000000000004';
  const MISSING_ID = 'd1000000-0000-0000-0000-000000000005';

  it('creates a named tag exactly once for the whole batch', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUST_A });
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: 'new-tag-id', name: 'New', color: '#6B7280' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
    mockPrisma.tagAssignment.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids: [CUST_A, CUST_B, CUST_C], name: 'New' });

    expect(res.status).toBe(200);
    expect(mockPrisma.tag.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tagAssignment.create).toHaveBeenCalledTimes(3);
    expect(res.body.tagged.sort()).toEqual([CUST_A, CUST_B, CUST_C].sort());
  });

  it('isolates an already-tagged id and a cross-org id into failed', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === MISSING_ID ? null : { id: args.where.id }));
    mockPrisma.tagAssignment.findUnique.mockImplementation((args: { where: { tag_id_entity_type_entity_id: { entity_id: string } } }) =>
      Promise.resolve(args.where.tag_id_entity_type_entity_id.entity_id === TAGGED_ID ? { tag_id: TAG_FIXTURE.id } : null));
    mockPrisma.tagAssignment.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids: [CUST_A, TAGGED_ID, MISSING_ID], tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(200);
    expect(res.body.tagged).toEqual([CUST_A]);
    expect(res.body.failed).toEqual(
      expect.arrayContaining([
        { id: TAGGED_ID, error: 'Tag already attached to this customer' },
        { id: MISSING_ID, error: 'customer not found' },
      ]),
    );
  });

  it('rejects more than 100 ids at the validation layer', async () => {
    mockAuthAs('admin');
    const ids = Array.from({ length: 101 }, (_, i) => `d2000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids, tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(400);
  });

  // #2041 AC13/R5 — a rep must not be able to write a tag onto every customer in the org just
  // because they hold `update Customer` at the route level; the per-id `failed[]` message must be
  // indistinguishable from a nonexistent id (never an existence oracle).
  it('SALES: tags an associated customer, reports an unassociated one in failed with the SAME message a nonexistent id gets', async () => {
    mockAuthAs('sales');
    const OWNED = CUST_A;
    const UNOWNED = CUST_B;
    mockPrisma.customer.findFirst.mockResolvedValue({ id: OWNED }); // tenancy existence, both ids
    (prisma.customer as unknown as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockImplementation(
      (args: { where: { id: string } }) =>
        Promise.resolve(
          args.where.id === OWNED ? { id: OWNED, created_by_id: TEST_USERS.sales.id } : { id: UNOWNED, created_by_id: null },
        ),
    );
    mockPrisma.tagAssignment.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('sales'))
      .send({ ids: [OWNED, UNOWNED], tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(200);
    expect(res.body.tagged).toEqual([OWNED]);
    expect(res.body.failed).toEqual([{ id: UNOWNED, error: 'customer not found' }]);
    expect(mockPrisma.tagAssignment.create).toHaveBeenCalledTimes(1);
  });

  it('a nonexistent id reports the SAME message an unassociated-but-real id gets (no oracle either way)', async () => {
    mockAuthAs('sales');
    const NONEXISTENT = MISSING_ID;
    mockPrisma.customer.findFirst.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === NONEXISTENT ? null : { id: args.where.id }));

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('sales'))
      .send({ ids: [NONEXISTENT], tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([{ id: NONEXISTENT, error: 'customer not found' }]);
  });
});

// #2041 AC13/R5 — POST /:id/tags (single-row) 404s the SAME way for an unassociated customer.
describe('POST /api/customers/:id/tags — row-scope (#2041)', () => {
  it('SALES, unassociated customer -> 404 "customer not found", never 403', async () => {
    mockAuthAs('sales');
    const UNOWNED = 'd1000000-0000-0000-0000-000000000009';
    mockPrisma.customer.findFirst.mockResolvedValue({ id: UNOWNED }); // tenancy existence
    (prisma.customer as unknown as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({
      id: UNOWNED, created_by_id: null,
    });

    const res = await request(app)
      .post(`/api/customers/${UNOWNED}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'customer not found' });
  });

  it('SALES, associated customer -> 201', async () => {
    mockAuthAs('sales');
    const OWNED = 'd1000000-0000-0000-0000-00000000000a';
    mockPrisma.customer.findFirst.mockResolvedValue({ id: OWNED });
    (prisma.customer as unknown as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({
      id: OWNED, created_by_id: TEST_USERS.sales.id,
    });
    mockPrisma.tagAssignment.create.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/customers/${OWNED}/tags`)
      .set(authHeader('sales'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(201);
  });
});
// ─── Tag-name normalisation on the entity-tag routes ────
//
// `addTagToEntitySchema` and `bulkTagEntitySchema` carried the same operator
// order as createTagSchema/updateTagSchema did: `.min(1).max(50).transform(trim)`.
// Zod applies a ZodString's checks in the order they are chained, so both length
// checks read the RAW string and the trim only happened on the way out.
//
// These two schemas could never mint a BLANK tag - a post-trim '' is falsy, so
// `resolveTagId` skips the find-or-create and the `.refine()` answers 400 - but
// they kept the other half of the bug: a legal 50-character name typed with
// surrounding whitespace was rejected here while the same name succeeded on
// POST /api/tags. These lock the whole tag-name surface to one behaviour.
describe('tag-name trimming on the entity-tag routes', () => {
  const NAME_50 = 'x'.repeat(50);

  it('accepts a padded 50-character name on POST /api/customers/:id/tags', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: TAG_FIXTURE.id, name: NAME_50, color: '#6B7280' });

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ name: `  ${NAME_50}  ` });

    expect(res.status).toBe(201);
    expect(mockPrisma.tag.create.mock.calls[0][0].data.name).toBe(NAME_50);
  });

  it('still 400s a whitespace-only name on POST /api/customers/:id/tags', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.tag.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });

  it('still rejects a name longer than 50 characters once trimmed', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.tag.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/tags`)
      .set(authHeader('admin'))
      .send({ name: 'x'.repeat(51) });

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });

  it('accepts a padded 50-character name on POST /api/customers/bulk-tag', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.tag.findUnique.mockResolvedValue(null);
    mockPrisma.tag.create.mockResolvedValue({ id: TAG_FIXTURE.id, name: NAME_50, color: '#6B7280' });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue(null);
    mockPrisma.tagAssignment.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids: [CUSTOMER_FIXTURE.id], name: `  ${NAME_50}  ` });

    expect(res.status).toBe(200);
    expect(mockPrisma.tag.create.mock.calls[0][0].data.name).toBe(NAME_50);
  });

  it('still 400s a whitespace-only name on POST /api/customers/bulk-tag', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.tag.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/customers/bulk-tag')
      .set(authHeader('admin'))
      .send({ ids: [CUSTOMER_FIXTURE.id], name: '   ' });

    expect(res.status).toBe(400);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
  });
});

/**
 * Malformed path ids on the per-record tag routes.
 *
 * Same root cause as the `PATCH/DELETE /api/tags/:id` guard: `:id` and `:tagId`
 * go straight into `where` clauses over Postgres `uuid` columns
 * (`entityExistsInOrg`, and `tagAssignment.findUnique` on the
 * `tag_id_entity_type_entity_id` composite key), so a stray path segment makes
 * the driver throw P2023 and the controller's catch dresses a client typo up as
 * a 500 — plus a Sentry page for a URL nobody could have resolved anyway.
 *
 * These assert that Prisma is never HANDED the malformed value, not merely that
 * the response is a 404. Against the mocked client a 404 comes back either way
 * (`tagAssignment.findUnique` is stubbed to null in `beforeEach`, so the handler
 * falls through to its own "not attached" 404), which would be a false green —
 * the mock never reproduces P2023. The not-called assertions are what actually
 * fail without the route guard.
 */
describe('per-record tag routes - malformed path ids', () => {
  it('404s a malformed :tagId on a customer without reaching Prisma', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/tags/not-a-uuid`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tagAssignment.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });

  it('404s a malformed :tagId on a job without reaching Prisma', async () => {
    mockAuthAs('admin');
    // SCOPED_JOB_ID, not JOB_FIXTURE.id: the latter is not a valid uuid, so it would trip the
    // `:id` guard and this case would pass without ever exercising the `:tagId` one.
    mockPrisma.job.findFirst.mockResolvedValue({ id: SCOPED_JOB_ID });
    mockPrisma.tagAssignment.findUnique.mockResolvedValue({ tag_id: TAG_FIXTURE.id });

    const res = await request(app)
      .delete(`/api/jobs/${SCOPED_JOB_ID}/tags/not-a-uuid`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tagAssignment.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });

  it('404s a malformed record :id on the detach route without reaching Prisma', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .delete(`/api/estimates/not-a-uuid/tags/${TAG_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.estimate.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tagAssignment.delete).not.toHaveBeenCalled();
  });

  // The attach route carries the same defect on `:id` - its `tag_id` comes from the
  // body, where addTagToEntitySchema already validates it as a uuid, but the record
  // id is a raw path segment reaching ensureEntityInOrg exactly as the detach route's is.
  it('404s a malformed record :id on the attach route without reaching Prisma', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/customers/not-a-uuid/tags')
      .set(authHeader('admin'))
      .send({ tag_id: TAG_FIXTURE.id });

    expect(res.status).toBe(404);
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tagAssignment.create).not.toHaveBeenCalled();
  });

  // The guard sits AFTER canDo, matching tag.routes.ts and inv-po.routes.ts: a caller
  // who may not touch the subject at all must not learn whether the id was well-formed.
  it('still 403s a role without the grant, rather than leaking that the id is malformed', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}/tags/not-a-uuid`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});
