import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { STARTER_TASK_CATEGORIES, TASK_CATEGORY_COLORS } from '../lib/tasks/categories';

// Admins manage task categories (visits-and-task-categories slice 09): create, rename and recolor.
// Only admins write (the TaskCategory subject has no create/update grant for any other role), a
// name is unique per organization whatever its letter case, and a color must come from the Tags
// palette - enforced here, not only by the picker. Prior art: inv-vendor-categories.test.ts.

type Row = { id: string; name: string; color: string; sort_order: number; organization_id: string };

const mockPrisma = prisma as unknown as {
  taskCategory: Record<'findFirst' | 'create' | 'update' | 'aggregate', ReturnType<typeof vi.fn>>;
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};

const FOLLOW_UP = 'c9000000-0000-4000-8000-000000000901';
const PART_ORDER = 'c9000000-0000-4000-8000-000000000902';
const OTHER_ORG_CAT = 'c9000000-0000-4000-8000-0000000009ff';

let rows: Row[];

/**
 * An in-memory task_categories table behind the mocked client, honouring the parts of a Prisma
 * `where` the controller relies on - the tenant filter, id / id-not, and a case-insensitive name
 * match - so the tests assert outcomes, not call shapes.
 */
function matches(row: Row, where: Record<string, any> = {}): boolean {
  if (where.organization_id && row.organization_id !== where.organization_id) return false;
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (where.id?.not && row.id === where.id.not) return false;
  if (where.name?.equals !== undefined) {
    const ci = where.name.mode === 'insensitive';
    const a = ci ? row.name.toLowerCase() : row.name;
    const b = ci ? String(where.name.equals).toLowerCase() : where.name.equals;
    if (a !== b) return false;
  }
  return true;
}

const pick = ({ id, name, color, sort_order }: Row) => ({ id, name, color, sort_order });

function installTable() {
  rows = [
    { id: FOLLOW_UP, name: 'Follow-up', color: '#22C55E', sort_order: 0, organization_id: ALPHA_ORG_ID },
    { id: PART_ORDER, name: 'Part order', color: '#F97316', sort_order: 1, organization_id: ALPHA_ORG_ID },
    { id: OTHER_ORG_CAT, name: 'Permit', color: '#8B5CF6', sort_order: 0, organization_id: ORG_B_ID },
  ];
  const t = mockPrisma.taskCategory;
  t.findFirst.mockImplementation(async ({ where }: any) => {
    const r = rows.find((x) => matches(x, where));
    return r ? pick(r) : null;
  });
  t.aggregate.mockImplementation(async ({ where }: any) => {
    const mine = rows.filter((x) => matches(x, where));
    return { _max: { sort_order: mine.length ? Math.max(...mine.map((x) => x.sort_order)) : null } };
  });
  t.create.mockImplementation(async ({ data }: any) => {
    const r: Row = { id: `c9000000-0000-4000-8000-00000000${String(rows.length).padStart(4, '0')}`, ...data };
    rows.push(r);
    return pick(r);
  });
  t.update.mockImplementation(async ({ where, data }: any) => {
    const r = rows.find((x) => x.id === where.id)!;
    Object.assign(r, data);
    return pick(r);
  });
}

const ours = () => rows.filter((r) => r.organization_id === ALPHA_ORG_ID);

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  mockPrisma.$executeRaw.mockResolvedValue(0);
  installTable();
});

describe('POST /api/task-categories', () => {
  it('an admin creates a category with a name and a palette color, placed last', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: '  Warranty  ', color: '#14B8A6' });

    expect(res.status).toBe(201);
    expect(res.body.category).toMatchObject({ name: 'Warranty', color: '#14B8A6', sort_order: 2 });
    expect(ours().map((r) => r.name)).toContain('Warranty');
    expect(rows.find((r) => r.name === 'Warranty')!.organization_id).toBe(ALPHA_ORG_ID);
  });
});

describe('POST /api/task-categories - refusals', () => {
  it('refuses a name another category already has, whatever its letter case, with a clear message', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: 'PART ORDER', color: '#EF4444' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A category named "PART ORDER" already exists.');
    expect(ours()).toHaveLength(2);
  });

  it('treats runs of spaces as one when checking for a duplicate', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: '  Part    ORDER ', color: '#EF4444' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A category named "Part ORDER" already exists.');
    expect(ours()).toHaveLength(2);
  });

  it('stores a name with its spaces tidied - trimmed, runs collapsed', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: ' Warranty \t  claim ', color: '#14B8A6' });

    expect(res.status).toBe(201);
    expect(res.body.category.name).toBe('Warranty claim');
  });

  it('ignores invisible format characters (zero-width space, BOM, word joiner) in a name', async () => {
    mockAuthAs('admin');

    const dup = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: 'Part\u200B or\u2060der', color: '#EF4444' });
    expect(dup.status).toBe(409);

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: '\uFEFFWar\u200Cranty\u200D', color: '#14B8A6' });
    expect(res.status).toBe(201);
    expect(res.body.category.name).toBe('Warranty');
  });

  it('a name used only by ANOTHER organization is free here', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: 'permit', color: '#8B5CF6' });

    expect(res.status).toBe(201);
    expect(ours().map((r) => r.name)).toContain('permit');
  });

  it('answers the same 409 when the unique index catches a concurrent same-name create', async () => {
    mockAuthAs('admin');
    mockPrisma.taskCategory.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: 'Warranty', color: '#14B8A6' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A category named "Warranty" already exists.');
  });

  it('refuses a color outside the Tags palette', async () => {
    mockAuthAs('admin');

    for (const color of ['#123456', 'red', '#22C55', '']) {
      const res = await request(app)
        .post('/api/task-categories')
        .set(authHeader('admin'))
        .send({ name: 'Warranty', color });
      expect(res.status, color).toBe(400);
    }
    expect(ours()).toHaveLength(2);
  });

  it('accepts a palette color in lower case and stores the palette spelling', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: 'Warranty', color: '#14b8a6' });

    expect(res.status).toBe(201);
    expect(res.body.category.color).toBe('#14B8A6');
  });

  it('refuses a blank name', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: '   ', color: '#14B8A6' });

    expect(res.status).toBe(400);
    expect(ours()).toHaveLength(2);
  });

  it('refuses a name longer than 50 characters, and stores nothing', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: 'A'.repeat(51), color: '#14B8A6' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Keep the name to 50 characters or fewer.');
    expect(ours()).toHaveLength(2);
  });

  it('accepts exactly 50 characters, counted after the surrounding spaces are trimmed', async () => {
    mockAuthAs('admin');
    const fifty = 'A'.repeat(50);

    const res = await request(app)
      .post('/api/task-categories')
      .set(authHeader('admin'))
      .send({ name: `   ${fifty}   `, color: '#14B8A6' });

    expect(res.status).toBe(201);
    expect(res.body.category.name).toBe(fifty);
    expect(ours().map((r) => r.name)).toContain(fifty);
  });
});

describe('PATCH /api/task-categories/:id', () => {
  it('refuses a rename longer than 50 characters, and the name is left as it was', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${PART_ORDER}`)
      .set(authHeader('admin'))
      .send({ name: 'B'.repeat(51) });

    expect(res.status).toBe(400);
    expect(rows.find((r) => r.id === PART_ORDER)!.name).toBe('Part order');
  });

  it('an admin renames and recolors a category', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${PART_ORDER}`)
      .set(authHeader('admin'))
      .send({ name: 'Parts to order', color: '#EAB308' });

    expect(res.status).toBe(200);
    expect(res.body.category).toEqual({ id: PART_ORDER, name: 'Parts to order', color: '#EAB308', sort_order: 1 });
    expect(rows.find((r) => r.id === PART_ORDER)).toMatchObject({ name: 'Parts to order', color: '#EAB308' });
  });

  it('a recolor alone leaves the name as it was', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${FOLLOW_UP}`)
      .set(authHeader('admin'))
      .send({ color: '#3B82F6' });

    expect(res.status).toBe(200);
    expect(res.body.category).toMatchObject({ name: 'Follow-up', color: '#3B82F6' });
  });

  it('a category may change the letter case of its own name', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${FOLLOW_UP}`)
      .set(authHeader('admin'))
      .send({ name: 'FOLLOW-UP' });

    expect(res.status).toBe(200);
    expect(res.body.category.name).toBe('FOLLOW-UP');
  });

  it('refuses renaming onto another category\'s name, whatever its letter case', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${FOLLOW_UP}`)
      .set(authHeader('admin'))
      .send({ name: 'part ORDER' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A category named "part ORDER" already exists.');
    expect(rows.find((r) => r.id === FOLLOW_UP)!.name).toBe('Follow-up');
  });

  it('refuses a rename that differs from another category only in spacing and case', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${FOLLOW_UP}`)
      .set(authHeader('admin'))
      .send({ name: 'part   order' });

    expect(res.status).toBe(409);
    expect(rows.find((r) => r.id === FOLLOW_UP)!.name).toBe('Follow-up');
  });

  it('refuses a color outside the Tags palette', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${FOLLOW_UP}`)
      .set(authHeader('admin'))
      .send({ color: '#000000' });

    expect(res.status).toBe(400);
    expect(rows.find((r) => r.id === FOLLOW_UP)!.color).toBe('#22C55E');
  });

  it('another organization\'s category is not found, and is left alone', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/task-categories/${OTHER_ORG_CAT}`)
      .set(authHeader('admin'))
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(rows.find((r) => r.id === OTHER_ORG_CAT)!.name).toBe('Permit');
  });

  it('refuses an empty change', async () => {
    mockAuthAs('admin');

    const res = await request(app).patch(`/api/task-categories/${FOLLOW_UP}`).set(authHeader('admin')).send({});

    expect(res.status).toBe(400);
  });
});

describe('only admins write task categories', () => {
  for (const role of ['dispatcher', 'sales', 'technician'] as const) {
    it(`${role}: create is refused with 403 and nothing is stored`, async () => {
      mockAuthAs(role);

      const res = await request(app)
        .post('/api/task-categories')
        .set(authHeader(role))
        .send({ name: 'Warranty', color: '#14B8A6' });

      expect(res.status).toBe(403);
      expect(ours()).toHaveLength(2);
    });

    it(`${role}: rename and recolor are refused with 403 and nothing changes`, async () => {
      mockAuthAs(role);

      const res = await request(app)
        .patch(`/api/task-categories/${FOLLOW_UP}`)
        .set(authHeader(role))
        .send({ name: 'Mine now', color: '#EF4444' });

      expect(res.status).toBe(403);
      expect(rows.find((r) => r.id === FOLLOW_UP)).toMatchObject({ name: 'Follow-up', color: '#22C55E' });
    });
  }
});

describe('the task category palette', () => {
  it('is the ten Tags colors, and holds every starter category color', () => {
    expect(TASK_CATEGORY_COLORS).toHaveLength(10);
    for (const s of STARTER_TASK_CATEGORIES) expect(TASK_CATEGORY_COLORS).toContain(s.color);
  });
});
