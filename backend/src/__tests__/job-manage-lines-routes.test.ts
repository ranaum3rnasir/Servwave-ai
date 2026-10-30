/**
 * PR 2 of the technician-ownership spec, route layer:
 * `manage_lines Job` is split out of `update Job`.
 *
 * What this file pins is the SEAM, not a policy. Two questions only:
 *
 *   1. Which routes moved? Line items and scopes moved to `manage_lines Job`; notes, tags and
 *      sub-status did NOT. A principal holding one action and not the other is the only way to
 *      observe the difference, so both synthetic principals below hold exactly one of the pair -
 *      a combination no default role produces (defaultGrants grants them together on purpose).
 *   2. Did anybody lose access? Every role that could edit job line items before the split is
 *      driven through a real request here and must still pass. That is the behaviour-neutrality
 *      proof at the route layer; the grant layer has its own in permissions-job-manage-lines.
 *
 * Harness mirrors job-lines.test.ts: supertest against `app`, prisma mocked by setup.ts, grants
 * injected with setCachedGrants.
 *
 * Roles & Permissions S01.8: `manage_lines Job` is now the Edit job line items switch, and the switch alone
 * decides (no creator exception), so a principal's `manage_lines` comes from `mockRoleSwitches`, not from a
 * stored grant. The Technician preset holds the switch on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_FIXTURE, TAG_FIXTURE, mockScopedFindFirst, mockRoleSwitches } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const JOB_ID = JOB_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000001';

const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } };

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: 'SUBMITTED',
    job_number: 'J00001',
    source_plan_id: null,
    customer_id: 'cust-1',
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    customer: { tax_exempt: false },
    // The technician is on the crew of the job's one visit (Attached: crew, Sold By or Dispatcher).
    visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
    estimate: null,
    job_line_items: [],
    invoices: [],
    scopes: [{ id: SCOPE_ID, title: 'Permit fee', body: '', flat_price: 300, is_taxable: true, internal_cost: null }],
    scheduled_start: null,
    scheduled_end: null,
    is_all_day: false,
    service_location: { state: 'CA' },
  };
}

// Every route the split moves, plus the ones it deliberately leaves behind. The split is only
// meaningful as a partition, so both halves are listed in one table and driven identically.
const MOVED_TO_MANAGE_LINES = [
  { name: 'POST   /:id/line-items',            method: 'post',   path: `/api/jobs/${JOB_ID}/line-items`,                  body: { description: 'Labor', quantity: 1, unit_price: 100 } },
  { name: 'PATCH  /:id/line-items/reorder',    method: 'patch',  path: `/api/jobs/${JOB_ID}/line-items/reorder`,          body: { order: [LINE_ID] } },
  { name: 'PATCH  /:id/line-items/:lineId',    method: 'patch',  path: `/api/jobs/${JOB_ID}/line-items/${LINE_ID}`,       body: { quantity: 2 } },
  { name: 'DELETE /:id/line-items/:lineId',    method: 'delete', path: `/api/jobs/${JOB_ID}/line-items/${LINE_ID}`,       body: undefined },
  { name: 'POST   /:id/scopes',                method: 'post',   path: `/api/jobs/${JOB_ID}/scopes`,                      body: { title: 'Permit fee', flat_price: 300 } },
  { name: 'PATCH  /:id/scopes/reorder',        method: 'patch',  path: `/api/jobs/${JOB_ID}/scopes/reorder`,              body: { order: [SCOPE_ID] } },
  { name: 'PATCH  /:id/scopes/:idx',           method: 'patch',  path: `/api/jobs/${JOB_ID}/scopes/0`,                    body: { is_taxable: false } },
  { name: 'DELETE /:id/scopes/:idx',           method: 'delete', path: `/api/jobs/${JOB_ID}/scopes/0`,                    body: undefined },
] as const;

// Edit jobs (S01.11): `update Job` is that switch. A job's notes left it for Add notes, so they are not in this list.
const STAYS_ON_UPDATE = [
  { name: 'POST   /:id/tags',        method: 'post',   path: `/api/jobs/${JOB_ID}/tags`,                      body: { tag_id: TAG_FIXTURE.id } },
  { name: 'DELETE /:id/tags/:tagId', method: 'delete', path: `/api/jobs/${JOB_ID}/tags/${TAG_FIXTURE.id}`,    body: undefined },
  { name: 'POST   /:id/sub-status',  method: 'post',   path: `/api/jobs/${JOB_ID}/sub-status`,                body: { sub_status_id: null } },
] as const;

const NOTE_ROUTE = { name: 'POST   /:id/notes', method: 'post', path: `/api/jobs/${JOB_ID}/notes`, body: { content: 'called the customer' } };

function send(route: { method: string; path: string; body?: Record<string, unknown> }, user: 'admin' | 'dispatcher' | 'technician') {
  const req = (request(app) as any)[route.method](route.path).set(authHeader(user));
  return route.body === undefined ? req : req.send(route.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.job.findUnique.mockResolvedValue(jobRow());
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
  mockPrisma.job.update.mockResolvedValue(jobRow());
  mockPrisma.jobLineItem?.findMany?.mockResolvedValue([]);
  mockPrisma.jobLineItem?.create?.mockResolvedValue({ id: LINE_ID, job_id: JOB_ID });
  mockPrisma.jobLineItem?.update?.mockResolvedValue({ id: LINE_ID, job_id: JOB_ID });
  mockPrisma.jobLineItem?.deleteMany?.mockResolvedValue({ count: 1 });
  mockPrisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(mockPrisma) : Promise.all(arg as Promise<unknown>[]),
  );
});

describe('a principal with `update Job` but NOT `manage_lines Job`', () => {
  beforeEach(() => {
    mockAuthAs('technician');
    // `update Job` is the Edit jobs switch (S01.11), not a stored grant.
    mockRoleSwitches({ edit_jobs: true, edit_job_line_items: false });
  });

  it.each(MOVED_TO_MANAGE_LINES)('is refused on $name', async (route) => {
    const res = await send(route, 'technician');
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(mockPrisma.jobLineItem.create).not.toHaveBeenCalled();
    expect(mockPrisma.jobLineItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.jobLineItem.deleteMany).not.toHaveBeenCalled();
  });

  it.each(STAYS_ON_UPDATE)('is still allowed through the guard on $name', async (route) => {
    const res = await send(route, 'technician');
    expect(res.status).not.toBe(403);
  });
});

describe('a principal with `manage_lines Job` but NOT `update Job`', () => {
  beforeEach(() => {
    mockAuthAs('technician');
    mockRoleSwitches({ edit_jobs: false, edit_job_line_items: true });
  });

  it.each(MOVED_TO_MANAGE_LINES)('passes the guard on $name', async (route) => {
    const res = await send(route, 'technician');
    expect(res.status).not.toBe(403);
  });

  it.each(STAYS_ON_UPDATE)('is refused on $name', async (route) => {
    const res = await send(route, 'technician');
    expect(res.status).toBe(403);
  });

  // Notes left Edit jobs for their own switch (S01.11): this person, off Edit jobs, still adds one.
  it('adds a note on POST /:id/notes: Add notes decides, not Edit jobs', async () => {
    const res = await send(NOTE_ROUTE, 'technician');
    expect(res.status).not.toBe(403);
  });
});

describe('a principal with `update Job` but Add notes turned off', () => {
  it('is refused on POST /:id/notes', async () => {
    mockAuthAs('technician');
    mockRoleSwitches({ edit_jobs: true, add_notes: false });
    const res = await send(NOTE_ROUTE, 'technician');
    expect(res.status).toBe(403);
  });
});

// The five money fields ride the SAME PATCH as scope_notes/job_type, so the split cannot be made
// at the route - it needs a field-level check in the handler, exactly like the D14 reschedule
// guard already in there.
//
// Both principals below hold `read Pricing`. That is what makes these tests discriminating: the
// pre-existing cost-field guard 403s a price-blind requester on tax_rate/discount_* regardless,
// so without the pricing grant a green result would prove nothing about `manage_lines`.
describe('PATCH /api/jobs/:id - the money fields are field-level gated on manage_lines Job', () => {
  const MONEY_FIELDS: Record<string, unknown>[] = [
    { tax_rate: 0.0875 },
    { discount_type: 'PERCENTAGE' },
    { discount_value: 10 },
  ];

  const HARMLESS_FIELDS: Record<string, unknown>[] = [
    { scope_notes: 'bring a ladder' },
    { job_type: 'HVAC' },
  ];

  function grant(actions: string[]) {
    // `update Job` is the Edit jobs switch (S01.11) and `manage_lines Job` the Edit job line items switch (S01.8):
    // neither is a stored grant.
    mockRoleSwitches({ edit_jobs: actions.includes('update'), edit_job_line_items: actions.includes('manage_lines') });
  }

  beforeEach(() => {
    mockAuthAs('technician');
    mockPrisma.job.findMany.mockResolvedValue([]);
    // The money guard became PER-INSTANCE in PR 3 (`canActOnRow`, not a subject-level
    // `ability.can`), because every technician now holds a creator-conditioned `manage_lines Job`
    // and a subject-level check answers yes to all of them. So this describe needs a findFirst that
    // really evaluates the fragment: with a blanket truthy mock the refusals below all pass.
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      ...jobRow(),
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.technician.id,
    });
  });

  it.each(MONEY_FIELDS)('refuses `update Job` alone on %o', async (body) => {
    grant(['update']);
    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('technician')).send(body);
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it.each(MONEY_FIELDS)('allows `update` + `manage_lines` on %o', async (body) => {
    grant(['update', 'manage_lines']);
    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('technician')).send(body);
    expect(res.status).toBe(200);
  });

  it.each(HARMLESS_FIELDS)('leaves %o on `update Job` alone', async (body) => {
    grant(['update']);
    const res = await request(app).patch(`/api/jobs/${JOB_ID}`).set(authHeader('technician')).send(body);
    expect(res.status).toBe(200);
  });

  it('refuses the whole PATCH when a money field is smuggled in beside a harmless one', async () => {
    grant(['update']);
    const res = await request(app)
      .patch(`/api/jobs/${JOB_ID}`)
      .set(authHeader('technician'))
      .send({ scope_notes: 'bring a ladder', tax_rate: 0.0875 });
    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });
});

// PR 2's behaviour-neutrality proof: every principal that could edit job line items before the
// split still can after it, on the REAL default grants.
//
// PR 3 made half of that false on purpose, and this describe went on passing anyway - the blanket
// `mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID })` in the file's beforeEach answers
// "visible" to every fragment, including the creator one, so the technician case was asserting
// nothing. Re-expressed to the post-PR-3 truth, with a findFirst that really evaluates the scope:
// the org-wide roles keep everything, and the technician's access now depends on WHICH job.
describe('who keeps line-item access after the split', () => {
  it.each([
    { user: 'admin' as const, role: 'ADMIN' },
    { user: 'dispatcher' as const, role: 'DISPATCHER' },
  ])('$role keeps every moved route on its default grants, on any job', async ({ user }) => {
    mockAuthAs(user);
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      ...jobRow(),
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      visits: [],
    });
    for (const route of MOVED_TO_MANAGE_LINES) {
      const res = await send(route, user);
      expect(res.status, `${route.name} for ${user}`).not.toBe(403);
    }
  });

  it('TECHNICIAN keeps every moved route on a job they CREATED and are on', async () => {
    mockAuthAs('technician');
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      ...jobRow(),
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.technician.id,
    });
    for (const route of MOVED_TO_MANAGE_LINES) {
      const res = await send(route, 'technician');
      expect(res.status, `${route.name} for technician`).not.toBe(403);
    }
  });

  // S01.8 undid PR 3's deliberate loss: money follows the Edit job line items switch, not creation or
  // assignment. The Technician preset holds it on, so an assignee who did not make the job keeps every route...
  it('TECHNICIAN keeps every moved route on a job they are only assigned to: Edit job line items is on in their preset', async () => {
    mockAuthAs('technician');
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      ...jobRow(),
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
    });
    for (const route of MOVED_TO_MANAGE_LINES) {
      const res = await send(route, 'technician');
      expect(res.status, `${route.name} for technician`).not.toBe(403);
    }
  });

  // ...and with the switch off loses them all, even on a job they made and are on.
  it('TECHNICIAN LOSES every moved route with Edit job line items off, on a job they created and are on', async () => {
    mockAuthAs('technician');
    mockRoleSwitches({ edit_job_line_items: false });
    mockScopedFindFirst(mockPrisma.job.findFirst, {
      ...jobRow(),
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.technician.id,
    });
    for (const route of MOVED_TO_MANAGE_LINES) {
      const res = await send(route, 'technician');
      expect(res.status, `${route.name} for technician`).toBe(403);
    }
  });
});
