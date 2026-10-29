import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS, TEST_ORG } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// Task watcher roster (#1956) — `GET /api/users/assignable?purpose=taskWatcher`.
//
// WHY THIS SUITE EVALUATES THE WHERE-CLAUSE INSTEAD OF ASSERTING ITS SHAPE. The sibling
// roster suites assert the shape of `where` because that is all a `mockResolvedValue` can
// see. A shape assertion cannot answer the question this PRD actually asks — "which PEOPLE
// does a dispatcher get back" — and a test that only counted rows would pass against a
// version that leaked email addresses. So the mock below applies the real `where` AND the
// real `select` to a fixed cast, and every case asserts the exact id set that comes out.
//
// The trade is stated plainly: this evaluator understands the operators THIS controller
// uses (AND/OR/equality/`in`) and nothing more. It is not a Postgres. It is enough to catch
// the drift this module exists to prevent, and `tsc -b` still owns dead relation names.

const mockPrisma = prisma as any;

const DEPT_SALES = 'dddddddd-0000-0000-0000-00000000000a';
const DEPT_FIELD = 'dddddddd-0000-0000-0000-00000000000b';

type CastRow = {
  id: string;
  first_name: string;
  last_name: string;
  role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';
  is_active: boolean;
  organization_id: string;
  department_id: string | null;
  avatar_path: string | null;
  // Fields a picker must NEVER receive. Present on the row so that a controller which
  // widened `assignableSelect` would actually hand them back and fail the leak assertions.
  email: string;
  phone: string;
  phone_ext: string;
};

const person = (
  id: string,
  role: CastRow['role'],
  department_id: string | null,
  extra: Partial<CastRow> = {},
): CastRow => ({
  id,
  first_name: id,
  last_name: 'X',
  role,
  is_active: true,
  organization_id: ALPHA_ORG_ID,
  department_id,
  avatar_path: null,
  email: `${id}@test.com`,
  phone: '555-0100',
  phone_ext: '11',
  ...extra,
});

// The actors are the shared TEST_USERS (so `mockAuthAs` keeps working), given departments here.
const ADMIN = TEST_USERS.admin.id;
const SALES = TEST_USERS.sales.id;
const DISPATCHER = TEST_USERS.dispatcher.id;
const TECH = TEST_USERS.technician.id;

const CAST: CastRow[] = [
  person(ADMIN, 'ADMIN', null),
  person('admin-2', 'ADMIN', DEPT_FIELD),
  person(SALES, 'SALES', DEPT_SALES),
  person('sales-mate', 'SALES', DEPT_SALES),
  person(DISPATCHER, 'DISPATCHER', DEPT_FIELD),
  person(TECH, 'TECHNICIAN', DEPT_FIELD),
  person('tech-other', 'TECHNICIAN', DEPT_SALES),
  person('loner', 'TECHNICIAN', null),
  person('retired', 'SALES', DEPT_SALES, { is_active: false }),
  person('org-b', 'SALES', DEPT_SALES, { organization_id: ORG_B_ID }),
];

/** Evaluate the operators this controller emits. Anything unknown throws rather than passes. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((c) => matches(row, c));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, cond as Record<string, unknown>);
    if (cond !== null && typeof cond === 'object') {
      const ops = cond as Record<string, unknown>;
      if ('in' in ops) return (ops.in as unknown[]).includes(row[key]);
      if ('not' in ops) return row[key] !== ops.not;
      throw new Error(`test where-evaluator: unsupported operator on ${key}: ${JSON.stringify(ops)}`);
    }
    return row[key] === cond;
  });
}

/** Actor identity for `authenticate`, including the department the pool rule reads. */
function actingAs(key: keyof typeof TEST_USERS, departmentId: string | null) {
  mockAuthAs(key);
  mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
    const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
    if (!match) return Promise.resolve(null);
    return Promise.resolve({
      ...match,
      department_id: match.id === TEST_USERS[key].id ? departmentId : null,
      organization: TEST_ORG,
    });
  });
}

async function roster(key: keyof typeof TEST_USERS, departmentId: string | null, purpose = 'taskWatcher') {
  actingAs(key, departmentId);
  const res = await request(app)
    .get(`/api/users/assignable?purpose=${purpose}&eligible_for=task`)
    .set(authHeader(key));
  return res;
}

const ids = (res: { body: unknown }) => (res.body as { id: string }[]).map((u) => u.id).sort();

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // MANDATORY here, unlike the sibling suites: `authenticate` caches the RESOLVED user against
  // the bearer token, and these cases deliberately re-run the SAME user with a different
  // department. Without this, case two is answered out of case one's session and the cohort is
  // computed from a department the actor no longer has - a false green that looks like a pass.
  clearTokenCache();
  mockPrisma.rolePermission.findMany.mockImplementation((a: any) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === a.where.role)));
  // Apply the REAL where and the REAL select. Applying the select is what makes the
  // field-absence assertions below mean something: a widened `assignableSelect` would put
  // email back on the wire here, exactly as it would in production.
  mockPrisma.user.findMany.mockImplementation((args: any) => {
    const rows = CAST.filter((r) => matches(r as unknown as Record<string, unknown>, args.where));
    if (!args.select) return Promise.resolve(rows);
    const keys = Object.keys(args.select).filter((k) => args.select[k]);
    return Promise.resolve(
      rows.map((r) => Object.fromEntries(keys.map((k) => [k, (r as Record<string, unknown>)[k]]))),
    );
  });
});

describe('purpose=taskWatcher — the cohort: self + every admin + own department', () => {
  it('SALES in a department gets themselves, both admins, and their department', async () => {
    const res = await roster('sales', DEPT_SALES);
    expect(res.status).toBe(200);
    // sales-mate and tech-other share DEPT_SALES; admin-2 arrives on the ADMIN clause
    // despite sitting in another department. `loner` and the DEPT_FIELD staff do not.
    expect(ids(res)).toEqual([ADMIN, SALES, 'admin-2', 'sales-mate', 'tech-other'].sort());
  });

  it('SALES with NO department still gets themselves and every admin — never an empty picker', async () => {
    const res = await roster('sales', null);
    expect(ids(res)).toEqual([ADMIN, SALES, 'admin-2'].sort());
  });

  it('a departmentless actor is NOT grouped with other departmentless users', async () => {
    // `loner` also has department_id null. "Nobody set a department" is not a department.
    const res = await roster('sales', null);
    expect(ids(res)).not.toContain('loner');
  });

  it('DISPATCHER is NARROWER than the organization — the deliberate takeaway of this change', async () => {
    // Recorded on purpose. DISPATCHER holds `read User`, so before #1956 the Watchers field
    // answered them with the whole org. Under the cohort rule they get their own department
    // and the admins, and this test is what stops that narrowing being discovered in prod.
    const res = await roster('dispatcher', DEPT_FIELD);
    expect(ids(res)).toEqual([ADMIN, DISPATCHER, TECH, 'admin-2'].sort());
    const everyone = CAST.filter((r) => r.organization_id === ALPHA_ORG_ID && r.is_active).map((r) => r.id);
    expect(ids(res).length).toBeLessThan(everyone.length);
    expect(ids(res)).not.toContain('sales-mate');
  });

  it('TECHNICIAN gets their department, which is how dispatch stays reachable from the field', async () => {
    const res = await roster('technician', DEPT_FIELD);
    expect(ids(res)).toContain(DISPATCHER);
    expect(ids(res)).toEqual([ADMIN, DISPATCHER, TECH, 'admin-2'].sort());
  });

  it('ADMIN gets the whole organization through the manage-all short-circuit', async () => {
    const res = await roster('admin', DEPT_FIELD);
    expect(ids(res)).toEqual([ADMIN, SALES, DISPATCHER, TECH, 'admin-2', 'sales-mate', 'tech-other', 'loner'].sort());
  });

  it('ADMIN with NO department stays organization-wide', async () => {
    const res = await roster('admin', null);
    expect(ids(res)).toHaveLength(8);
  });
});

describe('purpose=taskWatcher — the filters the cohort intersects with, never short-circuits', () => {
  it('an INACTIVE colleague in the actor\'s own department is excluded', async () => {
    const res = await roster('sales', DEPT_SALES);
    expect(ids(res)).not.toContain('retired');
  });

  it('another tenant\'s user is excluded even when they share a department id', async () => {
    const res = await roster('sales', DEPT_SALES);
    expect(ids(res)).not.toContain('org-b');
  });

  it('the tenant clause is present on the query, not merely absent from the result', async () => {
    await roster('sales', DEPT_SALES);
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
  });
});

describe('purpose=taskWatcher — a roster is not a staff directory', () => {
  it('carries name, role, department and avatar — and NOT email, phone or extension', async () => {
    const res = await roster('sales', DEPT_SALES);
    const row = (res.body as Record<string, unknown>[])[0];
    expect(row).toHaveProperty('first_name');
    expect(row).toHaveProperty('role');
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('phone');
    expect(row).not.toHaveProperty('phone_ext');
    // Asserted across every row, not just the first: a leak on one row is a leak.
    for (const r of res.body as Record<string, unknown>[]) {
      expect(Object.keys(r)).not.toContain('email');
    }
  });

  it('never returns the private storage key, only a signed url', async () => {
    const res = await roster('sales', DEPT_SALES);
    for (const r of res.body as Record<string, unknown>[]) {
      expect(r).not.toHaveProperty('avatar_path');
    }
  });
});

describe('the assignee half is provably untouched', () => {
  it('purpose=task still answers DISPATCHER with the whole org (the #1950 hold, intact)', async () => {
    const res = await roster('dispatcher', DEPT_FIELD, 'task');
    expect(res.status).toBe(200);
    // The `taskHeldOpen` clause: a `read User` holder keeps the org-wide task assignee pool.
    // If #1956 had narrowed this, the watcher fix would have silently changed the ASSIGNEE field.
    expect(ids(res)).toEqual([ADMIN, SALES, DISPATCHER, TECH, 'admin-2', 'sales-mate', 'tech-other', 'loner'].sort());
  });

  it('purpose=task still answers SALES with self only', async () => {
    const res = await roster('sales', DEPT_SALES, 'task');
    expect(ids(res)).toEqual([SALES]);
  });
});

describe('purpose remains mandatory and closed', () => {
  it('rejects an unknown purpose rather than defaulting open', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await request(app)
      .get('/api/users/assignable?purpose=watcher')
      .set(authHeader('sales'));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('taskWatcher');
  });

  it('rejects a missing purpose', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await request(app).get('/api/users/assignable').set(authHeader('sales'));
    expect(res.status).toBe(400);
  });
});
