import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { readersWithEntityAccess } from '../lib/tasks/entityAccessCohort';
import {
  mockAuthAs,
  authHeader,
  matchesScopeWhere,
  TEST_USERS,
  ALPHA_ORG_ID,
  ORG_B_ID,
} from './helpers';

// ─── Warn when assigning someone who cannot see the linked entity (#05) ───────────────────────
//
// Advisory only. Assignment is unchanged - being assigned a task grants the TASK and nothing more,
// and a flagged candidate is still assignable. What is new is that the picker can SAY so before the
// assignee discovers #01's "Restricted job" placeholder.
//
// The interesting half is the shape of the question. #01 asked "one reader, many entities"; this is
// the transpose, "one entity, many readers", and the naive form is a permission derivation plus a
// query per candidate. The probe counts asserted below are what keep it from regressing to that.

const JOB_ID = '10000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = '20000000-0000-0000-0000-000000000001';
const LEAD_ID = '30000000-0000-0000-0000-000000000001';
const ESTIMATE_ID = '40000000-0000-0000-0000-000000000001';
const CREW_TECH_ID = '00000000-0000-0000-0000-0000000000a1';
const OTHER_TECH_ID = '00000000-0000-0000-0000-0000000000a2';
const ORG_B_TECH_ID = '00000000-0000-0000-0000-0000000000b1';

const mockPrisma = prisma as unknown as {
  user: { findMany: ReturnType<typeof vi.fn> };
  rolePermission: { findMany: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  job: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  lead: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  estimate: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  customer: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  task: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  taskSubtask: { findMany: ReturnType<typeof vi.fn> };
  timelineEvent: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  note: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

/**
 * The one job every probe in this suite runs against. `visits[].assignees[]` is TECHNICIAN's own
 * scope (OWN_JOB), `created_by_id` its second arm, and `estimate: null` makes SALES's
 * estimate-anchored read a non-match - three different fragment shapes over one row.
 */
const JOB_FIXTURE: Record<string, unknown> = {
  id: JOB_ID,
  organization_id: ALPHA_ORG_ID,
  job_number: 'J00934',
  job_type: 'Access Control',
  created_by_id: TEST_USERS.dispatcher.id,
  estimate: null,
  visits: [{ assignees: [{ user_id: CREW_TECH_ID }] }],
};

/**
 * The other three linkable kinds, each shaped so every role's real grant condition has something to
 * bite on. Together they cover all four scope shapes the module has to batch:
 *   JOB       OWN_OR_CREATED_JOB       relation path OR scalar
 *   LEAD      OWN_LEAD / OWN_WALKTHROUGH   two different relation paths
 *   ESTIMATE  OWN_ESTIMATE_VIA_LEAD_OR_CREATOR   a to-one hop OR an `AND` of scalars
 *   CUSTOMER  OWN_CUSTOMER (#2041)     three-arm OR: lead_assignees / job visit assignees / created_by_id
 */
const LEAD_FIXTURE: Record<string, unknown> = {
  id: LEAD_ID,
  organization_id: ALPHA_ORG_ID,
  lead_number: 'L00042',
  job_type: 'Service',
  lead_assignees: [{ user_id: TEST_USERS.sales.id }],
  visits: [{ assignees: [{ user_id: CREW_TECH_ID }] }],
};

/** Lead-less (customer-anchored), so ONLY the creator arm can grant it. */
const ESTIMATE_FIXTURE: Record<string, unknown> = {
  id: ESTIMATE_ID,
  organization_id: ALPHA_ORG_ID,
  estimate_number: 'E00042',
  lead_id: null,
  lead: null,
  created_by: CREW_TECH_ID,
};

/**
 * #2041 — SALES's `read Customer` grant is now row-scoped (OWN_CUSTOMER). Associated to SALES via
 * the FIRST OR-arm (a lead they are assigned to) deliberately — `resolveCohort`'s per-arm loop
 * breaks as soon as a cohort is fully granted, so matching on arm 1 keeps this a single-probe
 * cohort resolution rather than exhausting all three arms.
 */
const CUSTOMER_FIXTURE_ROW: Record<string, unknown> = {
  id: CUSTOMER_ID,
  organization_id: ALPHA_ORG_ID,
  company_name: 'Northgate Storage',
  first_name: null,
  last_name: null,
  customer_number: 'C00042',
  created_by_id: null,
  leads: [{ lead_assignees: [{ user_id: TEST_USERS.sales.id }] }],
  jobs: [],
};

/** A `users` row as the endpoint selects it. */
const candidate = (id: string, role: string) => ({
  id,
  role,
  organization_id: ALPHA_ORG_ID,
  custom_role_id: null,
  custom_role: null,
  department_id: null,
  location_id: null,
});

const ROSTER = [
  candidate(TEST_USERS.admin.id, 'ADMIN'),
  candidate(TEST_USERS.dispatcher.id, 'DISPATCHER'),
  candidate(TEST_USERS.sales.id, 'SALES'),
  candidate(CREW_TECH_ID, 'TECHNICIAN'),
  candidate(OTHER_TECH_ID, 'TECHNICIAN'),
];

/**
 * Apply a Prisma `select` to a fixture, honouring the `where` a relation select carries. The
 * cohort probe reads back WHICH candidate ids matched through exactly that shape, so a mock that
 * ignored the nested `where` would make the attribution look right while it was returning
 * everybody.
 */
function project(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    const value = row[key];
    if (spec === true) {
      out[key] = value ?? null;
      continue;
    }
    const { where, select: sub } = spec as { where?: Record<string, unknown>; select: Record<string, unknown> };
    if (Array.isArray(value)) {
      const kept = where
        ? value.filter((r) => matchesScopeWhere(where, r as Record<string, unknown>))
        : value;
      out[key] = kept.map((r) => project(r as Record<string, unknown>, sub));
    } else if (value && typeof value === 'object') {
      out[key] = project(value as Record<string, unknown>, sub);
    } else {
      out[key] = null;
    }
  }
  return out;
}

/** Answer a delegate's `findFirst` against a fixture: evaluate the real `where`, apply the `select`. */
function wireDelegate(
  delegate: { findFirst: ReturnType<typeof vi.fn> },
  fixture: Record<string, unknown>,
) {
  delegate.findFirst.mockImplementation(
    ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
      if (!matchesScopeWhere(where, fixture)) return Promise.resolve(null);
      return Promise.resolve(select ? project(fixture, select) : { id: fixture.id });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();

  mockAuthAs('admin');

  // mockAuthAs installs ONE role's grants. This endpoint derives a scope for EVERY role on the
  // roster, so the mock has to answer per `where.role` or every candidate resolves to the caller's
  // grant set and the whole suite is vacuous.
  mockPrisma.rolePermission.findMany.mockImplementation(({ where }: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === where.role)),
  );
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue([]);

  mockPrisma.user.findMany.mockResolvedValue(ROSTER);
  wireDelegate(mockPrisma.job, JOB_FIXTURE);
  wireDelegate(mockPrisma.lead, LEAD_FIXTURE);
  wireDelegate(mockPrisma.estimate, ESTIMATE_FIXTURE);
  wireDelegate(mockPrisma.customer, CUSTOMER_FIXTURE_ROW);
  // The caller's own label lookup (#01's resolveEntityLabels), not a cohort probe.
  mockPrisma.job.findMany.mockResolvedValue([
    { id: JOB_ID, job_number: 'J00934', job_type: 'Access Control' },
  ]);
});

const get = (query: string, as: 'admin' | 'dispatcher' | 'technician' = 'admin') =>
  request(app).get(`/api/tasks/entity-access${query}`).set(authHeader(as));

// ══════════════════════════════════════════════════════════════════════
// 1. Who is flagged
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/tasks/entity-access', () => {
  it('flags a candidate who cannot open the linked job, and names it', async () => {
    const res = await get(`?entity_type=JOB&entity_id=${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.without_access).toContain(OTHER_TECH_ID);
    expect(res.body.without_access).toContain(TEST_USERS.sales.id);
    expect(res.body.entity).toEqual({
      type: 'JOB',
      id: JOB_ID,
      label: 'J00934 · Access Control',
      redacted: false,
    });
  });

  it('does NOT flag a candidate who can open it', async () => {
    const res = await get(`?entity_type=JOB&entity_id=${JOB_ID}`);

    // On the crew (OWN_JOB), and the job's creator (CREATED_BY_ME) - both arms of the same grant.
    expect(res.body.without_access).not.toContain(CREW_TECH_ID);
    expect(res.body.without_access).not.toContain(TEST_USERS.dispatcher.id);
  });

  it('never flags an ADMIN', async () => {
    const res = await get(`?entity_type=JOB&entity_id=${JOB_ID}`);
    expect(res.body.without_access).not.toContain(TEST_USERS.admin.id);
  });

  it('reports the roster it actually evaluated', async () => {
    const res = await get(`?entity_type=JOB&entity_id=${JOB_ID}`);
    expect(res.body.checked_user_ids).toEqual(ROSTER.map((r) => r.id));
  });

  it('redacts the entity label for an assigner who cannot see it either', async () => {
    mockAuthAs('technician');
    mockPrisma.rolePermission.findMany.mockImplementation(({ where }: { where: { role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === where.role)),
    );
    mockPrisma.job.findMany.mockResolvedValue([]); // the label query, scoped, returns nothing

    const res = await get(`?entity_type=JOB&entity_id=${JOB_ID}`, 'technician');

    expect(res.status).toBe(200);
    expect(res.body.entity.redacted).toBe(true);
    expect(res.body.entity.label).toBe('Restricted job');
    expect(JSON.stringify(res.body)).not.toContain('J00934');
  });

  it('404s a link whose entity is gone, rather than flagging the whole roster', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(null);
    const res = await get(`?entity_type=JOB&entity_id=${JOB_ID}`);
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. No linked entity → nothing happens at all
// ══════════════════════════════════════════════════════════════════════
describe('a task with no linked entity', () => {
  it('400s without an entity, and does no roster or probe work', async () => {
    const res = await get('');

    expect(res.status).toBe(400);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an entity_type outside the four linkable kinds', async () => {
    const res = await get(`?entity_type=INVOICE&entity_id=${JOB_ID}`);
    expect(res.status).toBe(400);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('readersWithEntityAccess reports nobody, with no probes, for an unknown ref', async () => {
    const out = await readersWithEntityAccess(ROSTER, { type: '', id: '' });
    expect([...out.withAccess]).toEqual([]);
    expect(out.probes).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. The batching bound - the point of the whole exercise
// ══════════════════════════════════════════════════════════════════════
describe('batching', () => {
  /** 40 candidates over the same four roles the 5-person roster covers. */
  const BIG_ROSTER = [
    candidate(TEST_USERS.admin.id, 'ADMIN'),
    candidate(TEST_USERS.dispatcher.id, 'DISPATCHER'),
    candidate(TEST_USERS.sales.id, 'SALES'),
    candidate(CREW_TECH_ID, 'TECHNICIAN'),
    ...Array.from({ length: 36 }, (_, i) =>
      candidate(`00000000-0000-0000-0000-0000000${String(i + 100).padStart(5, '0')}`, 'TECHNICIAN'),
    ),
  ];

  /**
   * EVERY linkable kind, because the bound held for JOB and quietly did not for ESTIMATE: its
   * creator arm is `AND: [{lead_id: null}, {created_by: P}]`, an ARRAY, which `buildMirror` used to
   * reject - so the picker fell back to one query per candidate and staging measured probes == 222
   * for 222 readers. Testing only the entity type that passes is how that shipped.
   *
   * Expected counts are per DISTINCT resolved fragment, not per role:
   *   JOB       {org} for ADMIN+DISPATCHER · SALES via-estimate · TECHNICIAN's two arms   = 4
   *   LEAD      {org} · SALES own-lead · TECHNICIAN own-walkthrough                       = 3
   *   ESTIMATE  {org} · SALES and TECHNICIAN share ONE fragment, two arms                 = 3
   *   CUSTOMER  {org} for ADMIN+DISPATCHER (1) · SALES's OWN_CUSTOMER matches on the FIRST
   *             OR-arm (lead_assignees), so the per-arm loop breaks after one probe (1) ·
   *             TECHNICIAN has no `read Customer` grant at all -> MATCH_NOTHING (`id:{in:[]}}`)
   *             — unlike the deleted CASL-subject branch's `null` (a free skip), MATCH_NOTHING
   *             is a real (if wasted) fragment now that CUSTOMER is a ScopeResource, so the two
   *             technicians' shared profile still costs one (batched) probe            = 3
   */
  const CASES: [string, string, number][] = [
    ['JOB', JOB_ID, 4],
    ['LEAD', LEAD_ID, 3],
    ['ESTIMATE', ESTIMATE_ID, 3],
    ['CUSTOMER', CUSTOMER_ID, 3],
  ];

  it.each(CASES)(
    'a %s costs the same probe count for a 5-candidate roster as for 40',
    async (type, id, expected) => {
      const small = await readersWithEntityAccess(ROSTER, { type, id });
      const big = await readersWithEntityAccess(BIG_ROSTER, { type, id });

      expect(small.probes).toBe(expected);
      expect(big.probes).toBe(expected);
      // A fallback is correct but linear. Zero here is the assertion that the mirror still
      // expresses every shape the shipped grants actually use.
      expect(small.fallbacks).toBe(0);
      expect(big.fallbacks).toBe(0);
    },
  );

  it('answers the ESTIMATE creator arm from ONE probe, not one per candidate', async () => {
    const out = await readersWithEntityAccess(BIG_ROSTER, { type: 'ESTIMATE', id: ESTIMATE_ID });

    // Lead-less estimate: the via-lead arm grants nobody, the `AND` creator arm grants its author.
    expect(out.withAccess.has(CREW_TECH_ID)).toBe(true);
    expect(out.withAccess.has(TEST_USERS.sales.id)).toBe(false);
    expect(out.withAccess.has(BIG_ROSTER[10].id)).toBe(false);
    expect(out.probes).toBeLessThan(BIG_ROSTER.length);
    expect(out.fallbacks).toBe(0);
  });

  it('does not spend a probe on a department no grant condition mentions', async () => {
    // Same roles, but every reader in a department of their own - the shape that measured 92 probes
    // on staging for a 52-reader roster, worse than the per-reader path this module replaces.
    const spread = BIG_ROSTER.map((r, i) => ({ ...r, department_id: `dept-${i}` }));
    const out = await readersWithEntityAccess(spread, { type: 'JOB', id: JOB_ID });

    expect(out.probes).toBe(4);
  });

  it('still answers per candidate inside a shared profile', async () => {
    const big = await readersWithEntityAccess(BIG_ROSTER, { type: 'JOB', id: JOB_ID });

    // Same role, same department, same location as the 36 others - the crew membership is the
    // ONLY thing that differs, which is exactly what profile-grouping alone would have lost.
    expect(big.withAccess.has(CREW_TECH_ID)).toBe(true);
    expect(big.withAccess.has(BIG_ROSTER[10].id)).toBe(false);
    expect(big.withAccess.has(TEST_USERS.admin.id)).toBe(true);
    expect(big.withAccess.has(TEST_USERS.sales.id)).toBe(false);
  });

  it('loads per-user permission overrides for the whole roster in ONE query', async () => {
    await readersWithEntityAccess(BIG_ROSTER, { type: 'JOB', id: JOB_ID });

    expect(mockPrisma.userPermissionOverride.findMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.userPermissionOverride.findMany.mock.calls[0][0];
    expect(arg.where.user_id.in).toHaveLength(BIG_ROSTER.length - 1); // ADMIN is skipped
  });

  it('opening the picker is ONE request and does not re-query per candidate', async () => {
    const res = await get(`?entity_type=JOB&entity_id=${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
    // 1 existence probe + the 4 cohort probes above.
    expect(mockPrisma.job.findFirst).toHaveBeenCalledTimes(5);
  });

  it('never answers a reader under another organization\'s tenant', async () => {
    // Both are TECHNICIANs with the same department, location and (empty) override set, and BOTH
    // are on this job's crew - so they differ in nothing the profile key used to carry. Grouping
    // them would answer the outsider under the representative's org and grant them the job.
    const crewFixture = {
      ...JOB_FIXTURE,
      visits: [{ assignees: [{ user_id: CREW_TECH_ID }, { user_id: ORG_B_TECH_ID }] }],
    };
    wireDelegate(mockPrisma.job, crewFixture);
    const outsider = { ...candidate(ORG_B_TECH_ID, 'TECHNICIAN'), organization_id: ORG_B_ID };

    const out = await readersWithEntityAccess(
      [candidate(CREW_TECH_ID, 'TECHNICIAN'), outsider],
      { type: 'JOB', id: JOB_ID },
    );

    expect(out.withAccess.has(CREW_TECH_ID)).toBe(true);
    expect(out.withAccess.has(ORG_B_TECH_ID)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. The write path is untouched
// ══════════════════════════════════════════════════════════════════════
describe('assignment behaviour', () => {
  it('still assigns a user who cannot see the linked entity, with no extra check', async () => {
    const created = {
      id: 'aa000000-0000-0000-0000-000000000001',
      task_number: 'T00001',
      organization_id: ALPHA_ORG_ID,
      title: 'Go and ask about this job',
      description: '',
      status: 'TODO',
      priority: 'MEDIUM',
      assignee_ids: [OTHER_TECH_ID],
      watcher_ids: [] as string[],
      due_at: null,
      linked_entity_type: 'JOB',
      linked_entity_id: JOB_ID,
      tags: [] as string[],
      completed_at: null,
      created_by: TEST_USERS.admin.id,
      created_at: new Date('2026-08-25'),
      updated_at: new Date('2026-08-25'),
    };
    mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
    mockPrisma.task.create.mockResolvedValue(created);
    mockPrisma.taskSubtask.findMany.mockResolvedValue([]);
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
    // Org-membership probe and the name lookup both read `user.findMany`.
    mockPrisma.user.findMany.mockResolvedValue([
      { id: OTHER_TECH_ID, first_name: 'Off', last_name: 'Crew' },
    ]);

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({
        title: 'Go and ask about this job',
        assignee_ids: [OTHER_TECH_ID],
        linked_entity_type: 'JOB',
        linked_entity_id: JOB_ID,
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.task.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.task.create.mock.calls[0][0].data.assignee_ids).toEqual([OTHER_TECH_ID]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. CUSTOMER - now a real ScopeResource (#2041)
//
// #2041 conditioned SALES's read Customer to OWN_CUSTOMER, so CUSTOMER resolves through the SAME
// Prisma scope-fragment path JOB/LEAD/ESTIMATE do (`entityAccessScope`'s SCOPED branch, the
// dedicated CASL-subject branch this suite used to exercise is gone). TECHNICIAN still holds no
// `read Customer` grant at all, so this is still also the fail-closed path: a MATCH_NOTHING scope
// must flag the reader, not wave them through — `entityAccessScope` returns null exactly as it did
// for the deleted branch (`scopeWhereForUser` fails closed on a missing grant the same way).
// ══════════════════════════════════════════════════════════════════════
describe('a CUSTOMER-linked task', () => {
  beforeEach(() => {
    // The global beforeEach already wires `mockPrisma.customer` via `wireDelegate` against
    // CUSTOMER_FIXTURE_ROW (real per-`where` filtering) — only the label lookup needs its own mock.
    mockPrisma.customer.findMany.mockResolvedValue([
      { id: CUSTOMER_ID, company_name: 'Northgate Storage', first_name: null, last_name: null, customer_number: 'C00042' },
    ]);
  });

  it('flags every reader with no `read Customer` grant and clears the rest', async () => {
    const res = await get(`?entity_type=CUSTOMER&entity_id=${CUSTOMER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.entity).toEqual({
      type: 'CUSTOMER', id: CUSTOMER_ID, label: 'Northgate Storage', redacted: false,
    });
    // TECHNICIAN has no `read Customer` row in DEFAULT_GRANTS - entityAccessScope returns null.
    expect(res.body.without_access).toContain(CREW_TECH_ID);
    expect(res.body.without_access).toContain(OTHER_TECH_ID);
    expect(res.body.without_access).not.toContain(TEST_USERS.sales.id);
    expect(res.body.without_access).not.toContain(TEST_USERS.dispatcher.id);
    expect(res.body.without_access).not.toContain(TEST_USERS.admin.id);
  });

  it('costs no entity probe for a reader who cannot reach the subject at all', async () => {
    const out = await readersWithEntityAccess(ROSTER, { type: 'CUSTOMER', id: CUSTOMER_ID });

    // ADMIN+DISPATCHER share ONE unconditional `{organization_id}` fragment (1 probe); SALES's
    // OWN_CUSTOMER cohort matches on the FIRST OR-arm (lead_assignees), so its per-arm loop breaks
    // after one probe too (2); the two technicians share ONE MATCH_NOTHING cohort, which — unlike
    // the deleted CASL-subject branch's free `null` skip — still costs one wasted-but-batched probe
    // now that CUSTOMER is a real ScopeResource (3 total) — never one query per candidate either way.
    expect(out.probes).toBe(3);
    expect([...out.withAccess].sort()).toEqual(
      [TEST_USERS.admin.id, TEST_USERS.dispatcher.id, TEST_USERS.sales.id].sort(),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. A duplicated candidate list must not change the answer (QA)
// ══════════════════════════════════════════════════════════════════════
describe('a candidate list with duplicates', () => {
  it('returns the same access set as the deduped list', async () => {
    const once = await readersWithEntityAccess(ROSTER, { type: 'JOB', id: JOB_ID });
    const thrice = await readersWithEntityAccess([...ROSTER, ...ROSTER, ...ROSTER], { type: 'JOB', id: JOB_ID });

    expect([...thrice.withAccess].sort()).toEqual([...once.withAccess].sort());
    expect(thrice.probes).toBe(once.probes);
  });
});
