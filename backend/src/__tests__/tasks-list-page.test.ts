/* =============================================================================
   GET /api/tasks as a SERVER-SIDE PAGE (mobile slice 72).

   `GET /api/tasks` used to answer with every task in the organisation, and every filter ran in
   the browser. With `limit` it now answers one bounded page: the filters and the sort are
   composed into the Prisma query, the org scope is on every query, and the response says
   whether there is a next page. WITHOUT `limit` the legacy full list is untouched - the board,
   calendar, My Day, History and Dashboard views and the entity tabs still read it.

   These tests drive the real controller with a mocked Prisma and read the QUERY it sent: that
   is what "applied on the server" means. The semantics of the same query against a real
   database are in tasks-list-page-db.test.ts.
   ========================================================================== */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

const USER_A = '00000000-0000-0000-0000-0000000000a1';
const CAT_1 = '10000000-0000-0000-0000-0000000000c1';

const row = (n: number) => ({
  id: `aa000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  task_number: `T${String(n).padStart(5, '0')}`,
  organization_id: ALPHA_ORG_ID,
  title: `Task ${n}`,
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [] as string[],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  completed_at: null,
  created_by: '00000000-0000-0000-0000-000000000001',
  created_at: new Date('2026-06-17'),
  updated_at: new Date('2026-06-17'),
  watcher_ids: [],
  category: null,
  _count: { subtasks: 0 },
});

/** The first findMany the page asked for. */
const pageQuery = () => db.task.findMany.mock.calls[0][0] as {
  where: { AND?: unknown[]; organization_id?: string; OR?: unknown[] };
  orderBy: unknown;
  skip: number;
  take: number;
};
const flat = (q: ReturnType<typeof pageQuery>) => JSON.stringify(q.where);

beforeEach(() => {
  vi.clearAllMocks();
  db.task.findMany.mockResolvedValue([row(1), row(2)]);
  db.task.count.mockResolvedValue(5);
  db.task.groupBy.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  db.job.findMany.mockResolvedValue([]);
  db.lead.findMany.mockResolvedValue([]);
  db.estimate.findMany.mockResolvedValue([]);
  db.customer.findMany.mockResolvedValue([]);
  db.attachment.groupBy.mockResolvedValue([]);
});

describe('GET /api/tasks?limit= (a bounded page)', () => {
  it('asks the database for ONE page: take = limit, skip = offset, a stable default order', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/tasks?limit=2&offset=2').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const q = pageQuery();
    expect(q.take).toBe(2);
    expect(q.skip).toBe(2);
    // Newest first (what the list always showed), with the id as the tie-break so two pages
    // never overlap or skip a row when several tasks share a created_at.
    expect(q.orderBy).toEqual([{ created_at: 'desc' }, { id: 'asc' }]);
  });

  it('answers the page, its total and whether another page follows', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/tasks?limit=2&offset=2').set(authHeader('admin'));

    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.page).toEqual({ limit: 2, offset: 2, total: 5, has_more: true });
  });

  it('has_more is false on the last page', async () => {
    mockAuthAs('admin');
    db.task.count.mockResolvedValue(4);

    const res = await request(app).get('/api/tasks?limit=2&offset=2').set(authHeader('admin'));

    expect(res.body.page).toEqual({ limit: 2, offset: 2, total: 4, has_more: false });
  });

  it('scopes EVERY query to the caller\'s organisation: the page, the total and the category counts', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/tasks?limit=10').set(authHeader('admin'));

    expect(flat(pageQuery())).toContain(ALPHA_ORG_ID);
    expect(JSON.stringify(db.task.count.mock.calls[0][0])).toContain(ALPHA_ORG_ID);
    expect(JSON.stringify(db.task.groupBy.mock.calls[0][0])).toContain(ALPHA_ORG_ID);
  });

  it('keeps the non-admin visibility rule (assignee or watcher) on a page', async () => {
    mockAuthAs('technician');

    await request(app).get('/api/tasks?limit=10').set(authHeader('technician'));

    const where = JSON.stringify(pageQuery().where);
    expect(where).toContain('assignee_ids');
    expect(where).toContain('watcher_ids');
  });

  it('refuses a limit above the cap and a non-numeric one (400), so a page is always bounded', async () => {
    mockAuthAs('admin');

    const tooBig = await request(app).get('/api/tasks?limit=5000').set(authHeader('admin'));
    const junk = await request(app).get('/api/tasks?limit=abc').set(authHeader('admin'));
    const zero = await request(app).get('/api/tasks?limit=0').set(authHeader('admin'));

    expect([tooBig.status, junk.status, zero.status]).toEqual([400, 400, 400]);
    expect(db.task.findMany).not.toHaveBeenCalled();
  });

  it('WITHOUT limit the legacy full list is unchanged: no take, no skip, no page block', async () => {
    mockAuthAs('admin');

    const res = await request(app).get('/api/tasks').set(authHeader('admin'));

    const q = db.task.findMany.mock.calls[0][0];
    expect(q.take).toBeUndefined();
    expect(q.skip).toBeUndefined();
    expect(res.body.page).toBeUndefined();
    expect(db.task.count).not.toHaveBeenCalled();
  });
});

describe('GET /api/tasks?limit= (filters run in the query)', () => {
  it('member: tasks that member is ON (any-assignee, never equality on one person)', async () => {
    mockAuthAs('admin');
    await request(app).get(`/api/tasks?limit=10&member_id=${USER_A}`).set(authHeader('admin'));
    expect(flat(pageQuery())).toContain(JSON.stringify({ assignee_ids: { has: USER_A } }));
  });

  it('category: ids plus the "none" sentinel become category_id in / null', async () => {
    mockAuthAs('admin');
    await request(app).get(`/api/tasks?limit=10&category_ids=${CAT_1},none`).set(authHeader('admin'));
    const where = flat(pageQuery());
    expect(where).toContain(CAT_1);
    expect(where).toContain('"category_id":null');
  });

  it('due and created ranges are whole UTC days: from at 00:00, to up to (excluding) the next 00:00', async () => {
    mockAuthAs('admin');
    await request(app)
      .get('/api/tasks?limit=10&due_from=2026-07-01&due_to=2026-07-03&created_from=2026-06-01&created_to=2026-06-02')
      .set(authHeader('admin'));
    const where = flat(pageQuery());
    expect(where).toContain('"due_at":{"gte":"2026-07-01T00:00:00.000Z","lt":"2026-07-04T00:00:00.000Z"}');
    expect(where).toContain('"created_at":{"gte":"2026-06-01T00:00:00.000Z","lt":"2026-06-03T00:00:00.000Z"}');
  });

  it('overdue: due before now AND not finished', async () => {
    mockAuthAs('admin');
    await request(app).get('/api/tasks?limit=10&overdue=true').set(authHeader('admin'));
    const where = flat(pageQuery());
    expect(where).toMatch(/"due_at":\{"lt":"\d{4}-/);
    expect(where).toContain('"notIn":["DONE","CANCELLED"]');
  });

  it('department: tasks with ANY assignee in the department (users resolved inside the org)', async () => {
    mockAuthAs('admin');
    const DEPT = '20000000-0000-0000-0000-0000000000d1';
    db.user.findMany.mockResolvedValue([{ id: USER_A }]);
    await request(app).get(`/api/tasks?limit=10&department_id=${DEPT}`).set(authHeader('admin'));
    const userQuery = db.user.findMany.mock.calls.find((c: any) => c[0]?.where?.department_id === DEPT)![0];
    expect(userQuery.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(flat(pageQuery())).toContain(JSON.stringify({ assignee_ids: { hasSome: [USER_A] } }));
  });

  it('search: title, assignee names and (inside what the caller may open) the linked record', async () => {
    mockAuthAs('admin');
    db.user.findMany.mockResolvedValue([
      { id: USER_A, first_name: 'Dana', last_name: 'Reyes' },
      { id: '00000000-0000-0000-0000-0000000000a2', first_name: 'Sam', last_name: 'Lee' },
    ]);
    await request(app).get('/api/tasks?limit=10&q=dana%20rey').set(authHeader('admin'));
    const where = flat(pageQuery());
    expect(where).toContain('"title":{"contains":"dana rey","mode":"insensitive"}');
    // Only the person whose FULL name contains the text, as the old in-browser search did.
    expect(where).toContain(JSON.stringify({ assignee_ids: { hasSome: [USER_A] } }));
    expect(where).not.toContain('00000000-0000-0000-0000-0000000000a2');
    // The linked record is searched through the SAME read scope the label is resolved with.
    expect(db.job.findMany).toHaveBeenCalled();
    expect(JSON.stringify(db.job.findMany.mock.calls[0][0])).toContain(ALPHA_ORG_ID);
  });

  it('the Dashboard drill-down "blocked" and "open" become status clauses', async () => {
    mockAuthAs('admin');
    await request(app).get('/api/tasks?limit=10&drill=blocked').set(authHeader('admin'));
    expect(flat(pageQuery())).toContain('"status":"BLOCKED"');

    vi.clearAllMocks();
    db.task.findMany.mockResolvedValue([]);
    db.task.count.mockResolvedValue(0);
    db.task.groupBy.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    db.job.findMany.mockResolvedValue([]);
    await request(app).get('/api/tasks?limit=10&drill=open').set(authHeader('admin'));
    expect(flat(pageQuery())).toContain('"notIn":["DONE","CANCELLED"]');
  });

  it('a malformed filter value is a 400, never silently ignored', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/tasks?limit=10&due_from=yesterday').set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tasks?limit= (the two filters the database cannot compare on its own)', () => {
  const DAY = 24 * 3_600_000;
  const lastPageQuery = () => {
    const calls = db.task.findMany.mock.calls;
    return calls[calls.length - 1][0] as { where: unknown };
  };

  it('"Only show: At risk" reads the whole visible list, scores it, and pages only the at-risk ids', async () => {
    mockAuthAs('admin');
    const overdue5d = {
      id: 'aa000000-0000-0000-0000-00000000000a', status: 'TODO', assignee_ids: [USER_A],
      due_at: new Date(Date.now() - DAY), updated_at: new Date(Date.now() - 5 * DAY),
    };
    const fresh = {
      id: 'aa000000-0000-0000-0000-00000000000b', status: 'TODO', assignee_ids: [USER_A],
      due_at: null, updated_at: new Date(),
    };
    // 1st findMany: the scoring read; 2nd: the page.
    db.task.findMany.mockResolvedValueOnce([overdue5d, fresh]).mockResolvedValue([row(1)]);

    await request(app).get('/api/tasks?limit=10&at_risk=true').set(authHeader('admin'));

    // The scoring read is tenant-scoped like everything else, and asks only for open tasks.
    const scoring = db.task.findMany.mock.calls[0][0];
    expect(JSON.stringify(scoring.where)).toContain(ALPHA_ORG_ID);
    expect(JSON.stringify(scoring.where)).toContain('"notIn":["DONE","CANCELLED"]');
    // The page is cut over the at-risk ids only.
    expect(JSON.stringify(lastPageQuery().where)).toContain(JSON.stringify({ id: { in: [overdue5d.id] } }));
  });

  it('the Dashboard "onTime" drill-down keeps the done tasks finished no later than their due date', async () => {
    mockAuthAs('admin');
    const due = new Date('2026-07-01T00:00:00.000Z');
    const early = { id: 'aa000000-0000-0000-0000-0000000000e1', completed_at: new Date('2026-06-30T00:00:00.000Z'), due_at: due };
    const late = { id: 'aa000000-0000-0000-0000-0000000000e2', completed_at: new Date('2026-07-02T00:00:00.000Z'), due_at: due };
    db.task.findMany.mockResolvedValueOnce([early, late]).mockResolvedValue([row(1)]);

    await request(app).get('/api/tasks?limit=10&drill=onTime').set(authHeader('admin'));

    expect(JSON.stringify(lastPageQuery().where)).toContain(JSON.stringify({ id: { in: [early.id] } }));
    expect(JSON.stringify(lastPageQuery().where)).not.toContain(late.id);
  });

  it('the "atRisk" drill-down sizes the load over the FILTERED list (the Dashboard card\'s own scope)', async () => {
    mockAuthAs('admin');
    db.task.findMany.mockResolvedValueOnce([]).mockResolvedValue([]);

    await request(app).get(`/api/tasks?limit=10&drill=atRisk&member_id=${USER_A}`).set(authHeader('admin'));

    const scoring = JSON.stringify(db.task.findMany.mock.calls[0][0].where);
    // The member filter is already inside the set the load is counted over.
    expect(scoring).toContain(JSON.stringify({ assignee_ids: { has: USER_A } }));
  });
});

describe('GET /api/tasks?limit= (sorts run in the query)', () => {
  it.each([
    ['due_at', 'asc', [{ due_at: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]],
    ['due_at', 'desc', [{ due_at: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]],
    ['priority', 'desc', [{ priority: 'desc' }, { id: 'asc' }]],
    ['title', 'asc', [{ title: 'asc' }, { id: 'asc' }]],
    ['created_at', 'asc', [{ created_at: 'asc' }, { id: 'asc' }]],
  ])('sort=%s&dir=%s', async (sort, dir, expected) => {
    mockAuthAs('admin');
    await request(app).get(`/api/tasks?limit=10&sort=${sort}&dir=${dir}`).set(authHeader('admin'));
    expect(pageQuery().orderBy).toEqual(expected);
  });

  it('an unknown sort field is a 400 (never interpolated into the query)', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/tasks?limit=10&sort=organization_id').set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tasks?limit= (category counts for the filter window)', () => {
  it('sends the per-category counts on the first page, taken WITHOUT the category selection', async () => {
    mockAuthAs('admin');
    db.task.groupBy.mockResolvedValue([
      { category_id: CAT_1, _count: { _all: 3 } },
      { category_id: null, _count: { _all: 2 } },
    ]);

    const res = await request(app)
      .get(`/api/tasks?limit=10&category_ids=${CAT_1}`)
      .set(authHeader('admin'));

    expect(res.body.category_counts).toEqual({ [CAT_1]: 3, none: 2 });
    // Counted with every OTHER facet applied and the category facet left open: ticking a
    // category then shows exactly the number beside it.
    expect(JSON.stringify(db.task.groupBy.mock.calls[0][0].where)).not.toContain(CAT_1);
    expect(db.task.groupBy.mock.calls[0][0].by).toEqual(['category_id']);
  });

  it('is not recomputed for the later pages', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/tasks?limit=10&offset=10').set(authHeader('admin'));
    expect(res.body.category_counts).toBeUndefined();
    expect(db.task.groupBy).not.toHaveBeenCalled();
  });
});
