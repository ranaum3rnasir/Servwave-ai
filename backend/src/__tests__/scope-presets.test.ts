import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

const mockPrisma = prisma as unknown as {
  scopePreset: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/scope-presets', () => {
  it('lists org-scoped presets', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.findMany.mockResolvedValue([
      { id: 'sp-1', name: 'AC Changeout', emoji: '❄️', scope_text: 'Remove and replace...', priced: true, price: 500 },
    ]);

    const res = await request(app)
      .get('/api/scope-presets')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.presets).toHaveLength(1);
  });

  it('passes a search query through to name filtering', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/scope-presets?q=AC')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const callArgs = mockPrisma.scopePreset.findMany.mock.calls[0][0];
    expect(callArgs.where.name).toEqual({ contains: 'AC', mode: 'insensitive' });
  });

  // R5a (2026-07-21) — category is a free-text tag column, filtered the same way `q` already is.
  it('passes a category query through to category filtering', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/scope-presets?category=HVAC')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const callArgs = mockPrisma.scopePreset.findMany.mock.calls[0][0];
    expect(callArgs.where.category).toBe('HVAC');
  });

  it('blocks unauthenticated access', async () => {
    const res = await request(app).get('/api/scope-presets');
    expect(res.status).toBe(401);
  });

  // Live QA, 2026-08-05 - TECHNICIAN already held `create Estimate` (standalone estimates);
  // it now also holds a `read Estimate` grant (own-scoped), which passes this route's
  // subject-level canDo guard. Scope presets are org-wide reference data for BUILDING an
  // estimate's scope of work (same shape as PriceBook, which TECHNICIAN already reads) - a
  // technician who can create an estimate needs this list to do it, so this closes a pre-existing
  // usability gap rather than opening a new one.
  it('allows TECHNICIAN access (org-wide reference data, needed to build its own estimates)', async () => {
    mockAuthAs('technician');
    mockPrisma.scopePreset.findMany.mockResolvedValue([]);
    const res = await request(app)
      .get('/api/scope-presets')
      .set(authHeader('technician'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/scope-presets', () => {
  it('creates a priced preset scoped to the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.create.mockResolvedValue({
      id: 'sp-2', organization_id: TEST_USERS.admin.organization_id,
      name: 'Water Heater Install', emoji: null, scope_text: 'Install new unit', priced: true, price: 350,
    });

    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('admin'))
      .send({ name: 'Water Heater Install', scope_text: 'Install new unit', priced: true, price: 350 });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.scopePreset.create.mock.calls[0][0];
    expect(createArgs.data.organization_id).toBe(TEST_USERS.admin.organization_id);
    expect(createArgs.data.name).toBe('Water Heater Install');
    expect(createArgs.data.price).toBe(350);
  });

  it('nulls out price when priced is false, even if a price was sent', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.create.mockResolvedValue({ id: 'sp-3' });

    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('admin'))
      .send({ name: 'Free Estimate Visit', scope_text: 'Walkthrough', priced: false, price: 99 });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.scopePreset.create.mock.calls[0][0];
    expect(createArgs.data.price).toBeNull();
  });

  // B7 — a priced scope-of-work also carries taxability + cost basis (ScopeOfWork's shape);
  // before this fix, is_taxable/internal_cost were dropped on create() even though the
  // ScopePreset columns already existed, so a priced/taxed scope came back unpriced/untaxed.
  it('B7: persists is_taxable and internal_cost on a priced preset', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.create.mockResolvedValue({ id: 'sp-5' });

    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('admin'))
      .send({
        name: 'AC Changeout', scope_text: 'Remove and replace unit',
        priced: true, price: 500, is_taxable: false, internal_cost: 300,
      });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.scopePreset.create.mock.calls[0][0];
    expect(createArgs.data.is_taxable).toBe(false);
    expect(createArgs.data.internal_cost).toBe(300);
  });

  it('B7: is_taxable defaults true and internal_cost defaults null when omitted', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.create.mockResolvedValue({ id: 'sp-6' });

    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('admin'))
      .send({ name: 'Duct Cleaning', scope_text: 'Clean all ducts', priced: true, price: 150 });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.scopePreset.create.mock.calls[0][0];
    expect(createArgs.data.is_taxable).toBe(true);
    expect(createArgs.data.internal_cost).toBeNull();
  });

  it('R5a: persists a trimmed category', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.create.mockResolvedValue({ id: 'sp-7' });

    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('admin'))
      .send({ name: 'Duct Cleaning', scope_text: 'Clean all ducts', category: '  HVAC  ' });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.scopePreset.create.mock.calls[0][0];
    expect(createArgs.data.category).toBe('HVAC');
  });

  it('R5a: an omitted or blank category nulls out rather than saving an empty string', async () => {
    mockAuthAs('admin');
    mockPrisma.scopePreset.create.mockResolvedValue({ id: 'sp-8' });

    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('admin'))
      .send({ name: 'Duct Cleaning', scope_text: 'Clean all ducts', category: '   ' });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.scopePreset.create.mock.calls[0][0];
    expect(createArgs.data.category).toBeNull();
  });

  it('rejects a missing name', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('admin'))
      .send({ scope_text: 'No name provided' });

    expect(res.status).toBe(400);
  });

  it('SALES can create a preset (own update-Estimate grant)', async () => {
    mockAuthAs('sales');
    mockPrisma.scopePreset.create.mockResolvedValue({ id: 'sp-4' });

    const res = await request(app)
      .post('/api/scope-presets')
      .set(authHeader('sales'))
      .send({ name: 'Duct Cleaning', scope_text: 'Clean all ducts' });

    expect(res.status).toBe(201);
  });
});
