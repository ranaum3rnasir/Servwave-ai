import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { TEST_USERS, ALPHA_ORG_ID, mockAuthAs, authHeader, mockRoleGrantsWithout } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';

vi.mock('../lib/email', () => ({
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));
import { sendUserInviteEmail } from '../lib/email';
const mockSendInvite = sendUserInviteEmail as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  user: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  department: {
    findFirst: ReturnType<typeof vi.fn>;
  };
};

const mockSupabaseAdmin = supabaseAdmin as unknown as {
  auth: {
    admin: {
      createUser: ReturnType<typeof vi.fn>;
      deleteUser: ReturnType<typeof vi.fn>;
      listUsers: ReturnType<typeof vi.fn>;
    };
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════
// POST /api/users/invite
// ═══════════════════════════════════════════════════════

describe('POST /api/users/invite', () => {
  it('creates a login-capable user (has_login:true) and emails an invite — no Supabase account yet', async () => {
    mockAuthAs('admin');
    mockPrisma.user.create.mockResolvedValue({
      id: 'new-user-id',
      email: 'jane@test.com',
      first_name: 'Jane',
      last_name: 'Doe',
      role: 'TECHNICIAN',
      is_active: true,
      has_login: true,
      department_id: null,
      department: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'jane@test.com', role: 'TECHNICIAN', department_id: null });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'jane@test.com', has_login: true });
    expect(res.body.email_sent).toBe(true);
    expect(typeof res.body.invite_url).toBe('string');
    expect(res.body.invite_url).toContain('/accept-invite?token=');
    expect(mockSupabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockSendInvite).toHaveBeenCalledOnce();

    const createArgs = mockPrisma.user.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      email: 'jane@test.com',
      first_name: 'Jane',
      last_name: 'Doe',
      role: 'TECHNICIAN',
      has_login: true,
      organization_id: ALPHA_ORG_ID,
      department_id: null,
    });
  });

  it('validates the department belongs to the same org', async () => {
    mockAuthAs('admin');
    mockPrisma.department.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'jane2@test.com', role: 'TECHNICIAN', department_id: '00000000-0000-0000-0000-0000000000aa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/department/i);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('returns 409 (canonical message) via the P2002 backstop — race between the guard check and the write', async () => {
    mockAuthAs('admin');
    const prismaError = Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: ['email'] } });
    mockPrisma.user.create.mockRejectedValue(prismaError);
    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'dup@test.com', role: 'TECHNICIAN' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
  });

  it('still returns 201 with email_sent:false when the email fails', async () => {
    mockAuthAs('admin');
    mockSendInvite.mockResolvedValueOnce(false);
    mockPrisma.user.create.mockResolvedValue({
      id: 'new-user-id-2', email: 'k@test.com', first_name: 'K', last_name: 'L', role: 'SALES',
      is_active: true, has_login: true, department_id: null, department: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'K', last_name: 'L', email: 'k@test.com', role: 'SALES' });
    expect(res.status).toBe(201);
    expect(res.body.email_sent).toBe(false);
  });

  it('requires ADMIN role', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('dispatcher'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'x@test.com', role: 'TECHNICIAN' });
    expect(res.status).toBe(403);
  });

  it('rejects invalid email', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'not-an-email', role: 'TECHNICIAN' });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users (create)
// ═══════════════════════════════════════════════════════

describe('POST /api/users (create)', () => {
  it('creates a Supabase auth user + Prisma user for a brand-new email', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'supa-new-id' } }, error: null,
    });
    mockPrisma.user.create.mockResolvedValue({
      id: 'supa-new-id', email: 'brandnew@test.com', first_name: 'Brand', last_name: 'New',
      role: 'TECHNICIAN', is_active: true, has_login: true, department_id: null, department: null,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'brandnew@test.com', password: 'StrongPass!1', first_name: 'Brand', last_name: 'New', role: 'TECHNICIAN' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'brandnew@test.com' });
  });

  it('409s with the canonical message and never calls Supabase when the email already exists in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'existing-elsewhere' });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'taken@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'SALES' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockSupabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('409s with the canonical message when Supabase itself reports the email already exists (orphaned auth account)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
    });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'orphaned@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'SALES' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// GET /api/users/assignable — THE ASSIGNEE PICKER'S ROSTER
//
// Scoped assignee pool, slice 3. This suite is the old `GET /api/users?assignable=true` suite
// moved onto the route that replaced it, plus the cases the old one structurally could not have.
//
// WHY THE ROUTE EXISTS. The picker used to read `GET /api/users`, gated on `read User`, which
// DEFAULT_GRANTS carries for DISPATCHER and TECHNICIAN only. A salesperson opening their own
// lead's Walkthrough tab therefore got a 403, an empty roster, a Performers field reading "No more
// members" with a disabled trigger, a dead Schedule button, and their own chip rendered "Unknown".
//
// WHAT THE OLD SUITE COULD NOT CATCH, and case-groups B and C below now do. Every one of its nine
// cases asserted on `mockPrisma.user.findMany.mock.calls[0][0]` — the `where` and the `orderBy`.
// A query-shape assertion cannot see a field leak: the select could have been the whole staff
// directory and all nine would still have passed. `stubRoster` below closes that by projecting
// its FULL user fixtures through whatever select the handler actually passed, so a response-body
// assertion is finally load-bearing.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const ASSIGNABLE = '/api/users/assignable';

/**
 * Project a row through a Prisma `select`, the way Postgres would.
 *
 * WITHOUT THIS, EVERY FIELD-LEAK ASSERTION BELOW IS VACUOUS. Prisma is mocked, so `findMany`
 * returns whatever the stub holds no matter what was asked for — stub six narrow fields and even
 * an implementation selecting `userSelect` (email, phone, phone_ext, has_login, is_active, the
 * clock-in flags, the timestamps) answers with six. The fixtures here are therefore WHOLE user
 * rows and this is what removes the columns the handler did not ask for. Point the handler back
 * at `userSelect` and the "no email in the body" cases go red, which is the whole point of them.
 */
function projectSelect(
  row: Record<string, unknown>,
  select: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) {
      out[key] = row[key];
    } else if (spec && typeof spec === 'object' && 'select' in (spec as Record<string, unknown>)) {
      const nested = row[key] as Record<string, unknown> | null | undefined;
      out[key] = nested
        ? projectSelect(nested, (spec as { select: Record<string, unknown> }).select)
        : null;
    }
  }
  return out;
}

/** A whole `users` row, as the table really holds one — narrowed only by the handler's select. */
function userRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    email: 'someone@test.com',
    custom_role_id: null,
    custom_role: null,
    is_active: true,
    has_login: true,
    phone: '+15555550100',
    phone_ext: '204',
    avatar_path: null,
    department_id: null,
    department: null,
    enforce_clock_in_location: false,
    can_approve_clock_overrides: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

const DISPATCHER_ROW = userRow({
  id: TEST_USERS.dispatcher.id, first_name: 'Test', last_name: 'Dispatcher', role: 'DISPATCHER',
  email: 'dispatch@test.com', department_id: 'd1', department: { id: 'd1', name: 'HVAC Techs' },
});
const SALES_ROW = userRow({
  id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales', role: 'SALES',
  email: 'sales@test.com',
});
const ADMIN_ROW = userRow({
  id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin', role: 'ADMIN',
  email: 'admin@test.com',
});

/**
 * Stub the roster query. Honours two things the handler decides, so the assertions test the
 * handler and not the stub: the `select` (see `projectSelect`) and a self-scope `where.id`, which
 * is how "a non-holder receives exactly one row, their own" is proved rather than staged.
 */
function stubRoster(rows: Record<string, unknown>[] = [DISPATCHER_ROW, ADMIN_ROW, SALES_ROW]) {
  mockPrisma.user.findMany.mockImplementation(
    (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
      const narrowed = typeof args.where?.id === 'string'
        ? rows.filter((r) => r.id === args.where.id)
        : rows;
      return Promise.resolve(narrowed.map((r) => projectSelect(r, args.select)));
    },
  );
}

/** The `where` / `select` / `orderBy` the handler actually sent. */
function findArgs() {
  return mockPrisma.user.findMany.mock.calls[0][0];
}

describe('GET /api/users/assignable', () => {
  // The grant cache is keyed per role+org and survives `vi.clearAllMocks()`; a case that strips a
  // grant would otherwise poison the next case that expects the defaults back.
  beforeEach(() => clearPermissionCache());

  // ── A. THE BUG THIS ROUTE EXISTS FOR ────────────────────────────────────────────────────────

  it('gives a SALES user — who holds neither `read User` nor `assign User` — exactly one row, their own', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app)
      .get(`${ASSIGNABLE}?purpose=walkthroughPerformer`)
      .set(authHeader('sales'));

    // Not a 403, and not an empty array: an empty roster is what rendered "No more members" and
    // disabled the trigger, so "200 with nothing in it" would be the bug still shipped.
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(TEST_USERS.sales.id);
    // …and it is genuinely the id narrowing that did it, not a filter that happened to match.
    expect(findArgs().where.id).toBe(TEST_USERS.sales.id);
  });

  // THE FIELD LEAK. The row above is a picker row, not a staff record — and the fixture behind it
  // carries an email and a phone, so this fails against any implementation that reuses userSelect.
  it('carries no email and no phone on the row it returns to a self-only requester', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app)
      .get(`${ASSIGNABLE}?purpose=walkthroughPerformer`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body[0].email).toBeUndefined();
    expect(res.body[0].phone).toBeUndefined();
  });

  // The control that proves the route did not simply widen `read User`: the SAME principal is
  // still refused the staff directory the picker used to read.
  it('and that same SALES user is still refused GET /api/users', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app).get('/api/users').set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  // …and the SINGLE-user read route too. The plan's argument against the cheap fix (grant SALES
  // `read User`) is that it would open this route as well, so the split has to leave it shut.
  // `/assignable` is declared BEFORE `/:id`, which is what keeps the roster out of this handler —
  // this case is the other half of that ordering, proving `/:id` itself did not lose its gate.
  it('and that same SALES user is still refused GET /api/users/:id', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app)
      .get(`/api/users/${TEST_USERS.dispatcher.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  it('401s an unauthenticated caller', async () => {
    stubRoster();
    const res = await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`);
    expect(res.status).toBe(401);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  // ── B. THE ENVELOPE AND THE SELECT ──────────────────────────────────────────────────────────

  it('returns a BARE ARRAY of picker rows — id, name, role, department, avatar_url, nothing else', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    const res = await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(Object.keys(row).sort()).toEqual([
        'avatar_url', 'department', 'first_name', 'id', 'last_name', 'role',
      ]);
    }
    // The private storage key is swapped for the signed URL, never served raw.
    expect(res.body[0].avatar_path).toBeUndefined();
    expect(res.body[0].avatar_url).toBeNull();
    expect(res.body.find((r: { id: string }) => r.id === TEST_USERS.dispatcher.id).department)
      .toEqual({ id: 'd1', name: 'HVAC Techs' });
    expect(res.body.find((r: { id: string }) => r.id === TEST_USERS.sales.id).department).toBeNull();
  });

  // …and the query never asked for more, so a widened response cannot leak in later.
  it('never asks the database for email, phone or login state', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('dispatcher'));

    expect(findArgs().select).toEqual({
      id: true,
      first_name: true,
      last_name: true,
      role: true,
      department: { select: { id: true, name: true } },
      avatar_path: true,
    });
  });

  // ── C. THE POOL IS RESOLVED FROM THE ABILITY, PER PURPOSE ───────────────────────────────────

  it('gives a DISPATCHER — who holds `assign User` — the whole org pool', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    const res = await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    // No id narrowing at all — the pool was never scoped to one person.
    expect(findArgs().where.id).toBeUndefined();
  });

  it('gives an ADMIN the whole org pool through the manage-all short-circuit', async () => {
    mockAuthAs('admin');
    stubRoster();

    const res = await request(app).get(`${ASSIGNABLE}?purpose=walkthroughPerformer`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(findArgs().where.id).toBeUndefined();
  });

  // The grant, not the role name, is what widens the pool — strip it from the role that has it by
  // default and the same principal narrows to themselves.
  it('narrows a DISPATCHER stripped of `assign User` to exactly their own row', async () => {
    mockAuthAs('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['assign', 'User']);
    stubRoster();

    const res = await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(TEST_USERS.dispatcher.id);
  });

  // PURPOSE CHOOSES THE GRANT. `jobCrew` and `walkthroughPerformer` read `assign User`; `task`
  // reads the long-shipped `assign Task`. Collapse the two onto one grant and this case goes red.
  it('resolves the pool per purpose: a holder of `assign Task` alone gets the org for task and only themselves for jobCrew', async () => {
    // The two answers must differ for the SAME caller, or the purpose is not choosing anything.
    // The honest principal is one holding `assign Task` and neither `assign User` nor `read User`
    // - no seeded role is that, so it is built here. A single shared grant would silently strip
    // task assignment from exactly this custom role, which is why the mapping is per purpose.
    //
    // It also has to be built rather than borrowed from SALES: `task` is held open for holders of
    // `read User` (below), so a principal carrying that grant would answer `org` for task no
    // matter which grant the purpose selected, and this case would pass against a broken mapping.
    mockAuthAs('sales');
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
      { role: 'SALES', action: 'assign', subject: 'Task' },
    ]);
    clearPermissionCache();
    stubRoster();

    const crew = await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('sales'));
    const task = await request(app)
      .get(`${ASSIGNABLE}?purpose=task&eligible_for=task`)
      .set(authHeader('sales'));

    expect(crew.body).toHaveLength(1);
    expect(crew.body[0].id).toBe(TEST_USERS.sales.id);
    expect(task.body).toHaveLength(3);
  });

  it('holds `task` org-wide for a holder of `read User` - Tasks is out of this PRD\'s scope', async () => {
    // NOT an accident, and NOT the resolver being wrong. `assign Task` is in the catalog but in no
    // DEFAULT_GRANTS row - not even DISPATCHER - so scoping this purpose by the pool alone would
    // narrow the task assignee field to self for everyone but ADMIN. The task WRITE side has
    // always refused a non-holder naming anybody else, so the picker has long offered people the
    // save rejects; narrowing here would only make that mismatch visible, on a module this PRD is
    // not about. Ran's call: leave Tasks alone and decide separately whether DISPATCHER should
    // hold `assign Task` (issue #1950).
    //
    // THE HOLD IS CONDITIONED, and the condition is asserted by its sibling case below. A
    // DISPATCHER holds `read User`, so `origin/staging` answered them the whole roster from
    // `GET /api/users?assignable=true` - which is what "changes nothing" has to mean.
    //
    // When #1950 lands, DELETE the `taskHeldOpen` clause in the controller and this pair of tests
    // - the resolver already answers correctly and needs no change.
    mockAuthAs('dispatcher');
    stubRoster();

    const res = await request(app)
      .get(`${ASSIGNABLE}?purpose=task&eligible_for=task`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(findArgs().where.id).toBeUndefined();
  });

  // THE FINDING. An UNCONDITIONAL hold skipped the narrowing for EVERYONE, so this exact request -
  // one `fetch` from any authenticated session - handed a salesperson the whole staff roster.
  // `origin/staging` answered it 403, because SALES holds no `read User` and the picker read the
  // directory route. A hold that is meant to change nothing must not be a new way in.
  it('does NOT hold `task` open for a SALES user, who holds no `read User` - staging 403s them', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app)
      .get(`${ASSIGNABLE}?purpose=task&eligible_for=task`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(TEST_USERS.sales.id);
    // ...and it is genuinely the id narrowing that did it.
    expect(findArgs().where.id).toBe(TEST_USERS.sales.id);
  });

  // ...and `read User` is really the condition, not DISPATCHER's role name: strip it from the
  // role that holds it by default and the hold closes for them too.
  it('closes the `task` hold for a DISPATCHER stripped of `read User`', async () => {
    mockAuthAs('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['read', 'User']);
    stubRoster();

    const res = await request(app)
      .get(`${ASSIGNABLE}?purpose=task&eligible_for=task`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(TEST_USERS.dispatcher.id);
  });

  // ── C2. THE DIRECTORY FAMILY: GATED ON `read User`, WHICH IS WHAT STAGING GATED IT ON ───────
  //
  // `purpose=directory` is the list no pool rule governs - the lead OWNER picker, the job
  // DISPATCHER picker, calendar-entry PARTICIPANTS, the automation RECIPIENT pickers and the
  // assignee FILTER dropdowns. None of their writes consults `isAssigneeSetPermitted`, so scoping
  // them by `assign User` hid people the API accepts.

  it('gives a SALES user — who holds no `read User` — exactly one row for the directory purpose', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app).get(`${ASSIGNABLE}?purpose=directory`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(TEST_USERS.sales.id);
    expect(findArgs().where.id).toBe(TEST_USERS.sales.id);
  });

  it('gives a DISPATCHER — who holds `read User` — the whole org pool for the directory purpose', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    const res = await request(app).get(`${ASSIGNABLE}?purpose=directory`).set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(findArgs().where.id).toBeUndefined();
  });

  // THE GRANT, NOT THE POOL. A principal holding `assign User` but NOT `read User` is narrowed
  // here while it gets the org pool for crew - which is what makes `directory` a second family
  // rather than an alias. Fold `directory` back onto `resolveAssigneePoolForRequest` and this
  // goes red.
  it('scopes the directory purpose by `read User`, not by `assign User`', async () => {
    mockAuthAs('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['read', 'User']);
    stubRoster();

    const directory = await request(app)
      .get(`${ASSIGNABLE}?purpose=directory`)
      .set(authHeader('dispatcher'));
    const crew = await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('dispatcher'));

    expect(directory.body).toHaveLength(1);
    expect(directory.body[0].id).toBe(TEST_USERS.dispatcher.id);
    expect(crew.body).toHaveLength(3);
  });

  // ...and the converse, so neither direction can be a coincidence: `read User` without
  // `assign User` opens the directory and leaves the crew pool narrowed.
  it('leaves the crew pool narrowed for a holder of `read User` without `assign User`', async () => {
    mockAuthAs('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['assign', 'User']);
    stubRoster();

    const directory = await request(app)
      .get(`${ASSIGNABLE}?purpose=directory`)
      .set(authHeader('dispatcher'));
    const crew = await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('dispatcher'));

    expect(directory.body).toHaveLength(3);
    expect(crew.body).toHaveLength(1);
  });

  // ── D. `purpose` IS REQUIRED, AND IS NEVER DEFAULTED OPEN ───────────────────────────────────

  it('400s a request with no purpose, without touching the database', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    const res = await request(app).get(ASSIGNABLE).set(authHeader('dispatcher'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/purpose/i);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('400s an unrecognised purpose rather than falling back to a default pool', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    const res = await request(app).get(`${ASSIGNABLE}?purpose=jobcrew`).set(authHeader('dispatcher'));

    expect(res.status).toBe(400);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  // ── E. THE FILTERS, MOVED VERBATIM FROM THE `?assignable=true` SUITE ────────────────────────

  it('scopes to the tenant and to its active users', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('admin'));

    expect(findArgs().where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      is_active: true,
    });
    expect(findArgs().orderBy).toEqual([
      { department: { name: 'asc' } },
      { last_name: 'asc' },
      { first_name: 'asc' },
    ]);
  });

  it('filters by the assignable-role set (all active-user roles, #366) by default', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('admin'));

    expect(findArgs().where.role).toEqual({ in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] });
  });

  it('ignores the ad-hoc role query param — the eligibility set is fixed', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew&role=TECHNICIAN`).set(authHeader('admin'));

    expect(findArgs().where.role).toEqual({ in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] });
  });

  it('uses the owner-eligible set (all active-user roles, #366) when eligible_for=owner', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew&eligible_for=owner`).set(authHeader('admin'));

    // Bug #11 + #366: owner-eligibility equals the assignable pool (all four roles).
    expect(findArgs().where.role).toEqual({ in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] });
  });

  it('uses the narrow ADMIN+DISPATCHER set when eligible_for=dispatcher (#291)', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew&eligible_for=dispatcher`).set(authHeader('admin'));

    expect(findArgs().where.role).toEqual({ in: ['ADMIN', 'DISPATCHER'] });
  });

  it('omits the role filter for eligible_for=task (all active users incl. DISPATCHER)', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=task&eligible_for=task`).set(authHeader('admin'));

    // #434: tasks can be owned/watched by ANY active org user — no role restriction.
    expect(findArgs().where.role).toBeUndefined();
    expect(findArgs().where).toMatchObject({ organization_id: ALPHA_ORG_ID, is_active: true });
  });

  it('still applies the department scope for eligible_for=task without a role filter', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app)
      .get(`${ASSIGNABLE}?purpose=task&eligible_for=task&department_id=d1`)
      .set(authHeader('admin'));

    expect(findArgs().where.role).toBeUndefined();
    expect(findArgs().where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      is_active: true,
      department_id: 'd1',
    });
  });

  it('scopes to a department when department_id is provided', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew&department_id=d1`).set(authHeader('admin'));

    expect(findArgs().where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      is_active: true,
      department_id: 'd1',
      role: { in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] },
    });
  });

  it('does not apply a department filter when department_id is absent (org-wide borrow pool)', async () => {
    mockAuthAs('admin');
    stubRoster();

    await request(app).get(`${ASSIGNABLE}?purpose=jobCrew`).set(authHeader('admin'));

    expect(findArgs().where.department_id).toBeUndefined();
  });

  // The union that readmits people who are no longer eligible for NEW assignments but are still
  // ON existing ones — an inactive account, or a role outside the pool. Dropping them is what made
  // completeness filters lose genuinely-assigned users.
  it('unions in users referenced by existing job assignments, outside the is_active filter', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    await request(app)
      .get(`${ASSIGNABLE}?purpose=jobCrew&include_referenced_in=jobs`)
      .set(authHeader('dispatcher'));

    const { where } = findArgs();
    // `is_active` sits INSIDE the first OR arm, never at the top level — at the top level it would
    // re-exclude every inactive referenced user the union just readmitted.
    expect(where.is_active).toBeUndefined();
    expect(where.OR).toEqual([
      { is_active: true, role: { in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] } },
      { visit_assignments: { some: { visit: { job_id: { not: null } } } } },
    ]);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('unions in users referenced by existing lead assignments, walkthrough performers included', async () => {
    mockAuthAs('dispatcher');
    stubRoster();

    await request(app)
      .get(`${ASSIGNABLE}?purpose=walkthroughPerformer&include_referenced_in=leads`)
      .set(authHeader('dispatcher'));

    const { where } = findArgs();
    expect(where.is_active).toBeUndefined();
    expect(where.OR).toEqual([
      { is_active: true, role: { in: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] } },
      { lead_crew_memberships: { some: {} } },
      { commission_owned_leads: { some: {} } },
      { visit_assignments: { some: { visit: { lead_id: { not: null } } } } },
    ]);
  });

  // The union widens WHICH ROWS qualify; it does not widen WHOSE roster it is. A self-only
  // requester asking for it still gets themselves and no one else.
  it('does not let include_referenced_in widen a self-only pool', async () => {
    mockAuthAs('sales');
    stubRoster();

    const res = await request(app)
      .get(`${ASSIGNABLE}?purpose=walkthroughPerformer&include_referenced_in=leads`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(TEST_USERS.sales.id);
    expect(findArgs().where.id).toBe(TEST_USERS.sales.id);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/users — the staff directory the roster no longer lives in
// ═══════════════════════════════════════════════════════

describe('GET /api/users', () => {
  it('preserves the plain role filter and applies no assignable behaviour', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app).get('/api/users?role=SALES').set(authHeader('admin'));

    const args = mockPrisma.user.findMany.mock.calls[0][0];
    expect(args.where.role).toBe('SALES');
    expect(args.where.is_active).toBeUndefined();
    expect(args.orderBy).toEqual({ created_at: 'desc' });
  });

  // The assignable branch is GONE, not merely unreachable: leaving a second implementation behind
  // is how the two drift, and `include_referenced_in` used to trigger it WITHOUT `assignable`.
  it('ignores the retired assignable / include_referenced_in parameters entirely', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/users?assignable=true&include_referenced_in=jobs&eligible_for=owner&department_id=d1')
      .set(authHeader('admin'));

    const args = mockPrisma.user.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ organization_id: ALPHA_ORG_ID });
    expect(args.where.OR).toBeUndefined();
    expect(args.orderBy).toEqual({ created_at: 'desc' });
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users/:id/invite (resend invite for an existing row)
// ═══════════════════════════════════════════════════════

describe('POST /api/users/:id/invite (resend invite for an existing row)', () => {
  it('emails an invite for an existing user and flips has_login:true', async () => {
    mockAuthAs('admin');
    const existing = {
      id: '00000000-0000-0000-0000-000000000777',
      email: 'legacy@test.com', first_name: 'Leg', last_name: 'Acy', role: 'TECHNICIAN',
      is_active: true, has_login: false, organization_id: ALPHA_ORG_ID, department_id: null,
    };
    // The controller resolves the existing row via findFirst (org-scoped);
    // mockAuthAs already wires findUnique for the authenticate middleware.
    mockPrisma.user.findFirst.mockResolvedValue(existing);
    mockPrisma.user.update.mockResolvedValue({ ...existing, has_login: true, department: null, enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: new Date(), updated_at: new Date() });

    const res = await request(app)
      .post(`/api/users/${existing.id}/invite`).set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body.email_sent).toBe(true);
    expect(mockSendInvite).toHaveBeenCalledOnce();
    const updateArgs = mockPrisma.user.update.mock.calls[0][0];
    expect(updateArgs.data).toMatchObject({ has_login: true });
  });

  it('returns 404 for an unknown user', async () => {
    mockAuthAs('admin');
    // Controller resolves the row via findFirst; an unknown id is invisible.
    mockPrisma.user.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/users/00000000-0000-0000-0000-000000000999/invite').set(authHeader('admin')).send({});
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/users/:id — self-role-change guard
// ═══════════════════════════════════════════════════════

describe('PATCH /api/users/:id (self-role-change guard)', () => {
  it('rejects an admin changing their OWN role (lockout protection)', async () => {
    mockAuthAs('admin');
    // Even if the row would resolve, the self-role-change guard must short-circuit.
    mockPrisma.user.findFirst.mockResolvedValue(TEST_USERS.admin);

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.admin.id}`)
      .set(authHeader('admin'))
      .send({ role: 'SALES' });

    expect([400, 403]).toContain(res.status);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('allows an admin to edit their OWN non-role fields (e.g. first_name)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(TEST_USERS.admin);
    mockPrisma.user.update.mockResolvedValue({
      ...TEST_USERS.admin, first_name: 'Renamed', department: null,
      has_login: true, enforce_clock_in_location: false, can_approve_clock_overrides: false,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.admin.id}`)
      .set(authHeader('admin'))
      .send({ first_name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledOnce();
  });

  it("allows an admin to change ANOTHER user's role", async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ ...TEST_USERS.sales });
    mockPrisma.user.update.mockResolvedValue({
      ...TEST_USERS.sales, role: 'TECHNICIAN', department: null,
      has_login: true, enforce_clock_in_location: false, can_approve_clock_overrides: false,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.sales.id}`)
      .set(authHeader('admin'))
      .send({ role: 'TECHNICIAN' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/auth/me endpoint
// ═══════════════════════════════════════════════════════

describe('GET /api/auth/me endpoint', () => {
  it('returns abilityRules array for admin user', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.body.abilityRules).toBeDefined();
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
  });

  it('admin ability rules contain manage all', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('admin'));

    const rules: { action: string; subject: string }[] = res.body.abilityRules;
    expect(rules.some((r) => r.action === 'manage' && r.subject === 'all')).toBe(true);
  });

  it('returns abilityRules array for non-admin user', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.role).toBe('SALES');
    expect(res.body.abilityRules).toBeDefined();
    expect(Array.isArray(res.body.abilityRules)).toBe(true);
  });

  it('sales ability rules do not contain manage all', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/auth/me')
      .set(authHeader('sales'));

    const rules: { action: string; subject: string }[] = res.body.abilityRules;
    expect(rules.some((r) => r.action === 'manage' && r.subject === 'all')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/users/:id/permanent
// ═══════════════════════════════════════════════════════

describe('DELETE /api/users/:id/permanent', () => {
  const TARGET_ID = '00000000-0000-0000-0000-0000000000d1';

  const ZERO_COUNTS = {
    created_estimates: 0, created_notes: 0, uploaded_attachments: 0,
    time_entries: 0, timeclock_ot_reviews: 0, issued_refunds: 0, created_credits: 0,
    collected_payments: 0, voided_payments: 0, refunded_invoices: 0,
    commission_owned_leads: 0, dispatched_jobs: 0, service_plans_sold: 0,
    timeline_events: 0, cancelled_visits: 0,
  };

  const inactiveNoHistory = {
    id: TARGET_ID,
    email: 'gone@test.com',
    is_active: false,
    _count: { ...ZERO_COUNTS },
  };

  it('requires ADMIN role', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
  });

  it('refuses to delete your own account', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .delete(`/api/users/${TEST_USERS.admin.id}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('404s when the user is outside the caller org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('409s when the user is still active (deactivate first)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ ...inactiveNoHistory, is_active: true });
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deactivate/i);
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('409s with a reason when the user has history', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({
      ...inactiveNoHistory,
      _count: { ...ZERO_COUNTS, created_estimates: 3, collected_payments: 1 },
    });
    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/history/i);
    expect(res.body.error).toMatch(/estimates/i);
    expect(mockPrisma.user.delete).not.toHaveBeenCalled();
  });

  it('hard-deletes an inactive user with no history and removes the auth account', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(inactiveNoHistory);
    mockPrisma.user.delete.mockResolvedValue({ id: TARGET_ID });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'supa-xyz', email: 'gone@test.com' }] }, error: null,
    });
    mockSupabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });

    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
    expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: TARGET_ID } });
    expect(mockSupabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('supa-xyz');
  });

  it('still succeeds when there is no Supabase auth account to remove', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(inactiveNoHistory);
    mockPrisma.user.delete.mockResolvedValue({ id: TARGET_ID });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });

    const res = await request(app)
      .delete(`/api/users/${TARGET_ID}/permanent`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

// Reference TEST_USERS to keep the import marked as used by ESLint.
void TEST_USERS;
