import { vi } from 'vitest';
import { supabaseAdmin } from '../lib/supabase';
import { prisma } from '../lib/prisma';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Org Constants ──────────────────────────────────

export const ALPHA_ORG_ID = '00000000-0000-0000-0000-000000000001';
export const ORG_B_ID     = '00000000-0000-0000-0000-000000000002';
// A third, distinct org id. `mockAuthAs` resolves it to the same full-featured
// TEST_ORG as every other test user by default; a test that wants to prove a
// requireFeature() gate is actually wired on a route overrides the resolved
// `organization` to a lower plan for that one request (see e.g.
// comm-phone-access.test.ts, comm-my-number.test.ts).
export const REAL_ORG_ID  = '00000000-0000-0000-0000-0000000000f0';

// ─── Test Users ─────────────────────────────────────

export const TEST_USERS = {
  admin: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'admin@test.com',
    first_name: 'Test',
    last_name: 'Admin',
    role: 'ADMIN' as const,
    is_active: true,
    organization_id: ALPHA_ORG_ID,
  },
  dispatcher: {
    id: '00000000-0000-0000-0000-000000000002',
    email: 'dispatch@test.com',
    first_name: 'Test',
    last_name: 'Dispatcher',
    role: 'DISPATCHER' as const,
    is_active: true,
    organization_id: ALPHA_ORG_ID,
  },
  sales: {
    id: '00000000-0000-0000-0000-000000000003',
    email: 'sales@test.com',
    first_name: 'Test',
    last_name: 'Sales',
    role: 'SALES' as const,
    is_active: true,
    organization_id: ALPHA_ORG_ID,
  },
  technician: {
    id: '00000000-0000-0000-0000-000000000004',
    email: 'tech@test.com',
    first_name: 'Test',
    last_name: 'Tech',
    role: 'TECHNICIAN' as const,
    is_active: true,
    organization_id: ALPHA_ORG_ID,
  },
  orgB_admin: {
    id: '00000000-0000-0000-0000-000000000005',
    email: 'admin@orgb.com',
    first_name: 'Org',
    last_name: 'B',
    role: 'ADMIN' as const,
    is_active: true,
    organization_id: ORG_B_ID,
  },
  // Admin of a third, distinct org — see REAL_ORG_ID above.
  realOrgAdmin: {
    id: '00000000-0000-0000-0000-000000000006',
    email: 'admin@realorg.com',
    first_name: 'Real',
    last_name: 'Org',
    role: 'ADMIN' as const,
    is_active: true,
    organization_id: REAL_ORG_ID,
  },
} as const;

export type TestUserKey = keyof typeof TEST_USERS;

// Entitlement fixture: tests run against a SCALE org with every built feature
// enabled, so requireFeature() never 402s a test that is exercising something
// else. A test that specifically wants a locked org overrides org_features on
// its own request (see requireFeature.test.ts).
export const TEST_ORG = {
  is_demo: false,
  plan: 'SCALE',
  trial_ends_at: null as Date | null,
  feature_overrides: {} as Record<string, unknown>,
};

// ─── Auth Mock Setup ────────────────────────────────

/**
 * Configure mocks so authenticate middleware passes for the given role.
 * Call in beforeEach or per-test.
 *
 * `orgOverrides` patches the resolved organization row for every request in the
 * test - the way to run a case against a lower plan, a feature_overrides map, or
 * a demo org (`{ is_demo: true }`) without hand-rolling a user.findUnique mock.
 */
export function mockAuthAs(userKey: TestUserKey, orgOverrides: Partial<typeof TEST_ORG> = {}) {
  const user = TEST_USERS[userKey];
  const org = { ...TEST_ORG, ...orgOverrides };

  // supabaseAdmin.auth.getUser resolves successfully for any Bearer token
  (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { user: { id: user.id, email: user.email } },
    error: null,
  });

  // prisma.user.findUnique — authenticate middleware looks up user by ID
  // Also used by lead.assign to look up the target user
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
    (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
      // auth-user.ts SELECTs `organization: { select: { is_demo, plan,
      // trial_ends_at, feature_overrides } }` — without it every test user
      // resolves to STARTER and every gated route 402s.
      return Promise.resolve(match ? { ...match, organization: org } : null);
    }
  );

  // prisma.rolePermission.findMany — attachAbility middleware loads grants for non-ADMIN users.
  // Return the default grants for this role so canDo() checks pass in tests.
  if (user.role !== 'ADMIN') {
    const roleGrants = DEFAULT_GRANTS.filter((g) => g.role === user.role);
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(roleGrants);
  }

  // attachAbility ALSO loads per-user permission overrides (RBAC Phase 2). Re-establish the
  // "no overrides" default here so vi.resetAllMocks() in a test's beforeEach doesn't leave
  // userPermissionOverride.findMany returning undefined (→ attachAbility 500). A test that
  // exercises overrides re-mocks userPermissionOverride.findMany itself.
  (prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

  // Multi-visit S1: booking a visit allocates its number via MAX(visit_seq). Same reasoning as the
  // override default above - a suite whose beforeEach calls vi.resetAllMocks() wipes setup.ts's
  // implementation, and an aggregate resolving to undefined 500s every scheduling route instead of
  // failing somewhere legible. "No visits yet" is the right default for a fresh fixture.
  (prisma.visit.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({ _max: { visit_seq: null } });

  return { user };
}

/**
 * Re-mock a role's grants as its DEFAULT_GRANTS minus the named (action, subject) pairs, and drop
 * the grant cache so the next request picks them up. Call AFTER `mockAuthAs`, which installs the
 * unmodified defaults.
 *
 * Exists because a role default is not a fixed fact. `read Pricing` is the live example: it is
 * written by the Roles UI "See financial data" switch, so "a price-blind technician" is a real,
 * supported configuration - but since the technician-ownership spec (Part C) it is no longer the
 * DEFAULT one. Suites that assert the price-blind projection have to build that principal on
 * purpose now instead of inheriting it, or they quietly stop testing anything:
 *
 *   mockAuthAs('technician');
 *   mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);
 */
export function mockRoleGrantsWithout(role: string, ...omit: [action: string, subject: string][]) {
  const grants = DEFAULT_GRANTS.filter(
    (g) => g.role === role && !omit.some(([a, s]) => g.action === a && g.subject === s),
  );
  (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(grants);
  clearPermissionCache();
}

/**
 * Evaluate a row-scope `where` fragment against a fixture row, for the fragment shapes the
 * permissions layer actually builds (`scopeWhereFor` + `canActOnRow`): scalar columns, to-one
 * relations (`estimate.lead.lead_assignees`), to-many `some`, AND / OR / NOT, and
 * MATCH_NOTHING's `id: { in: [] }`. A relation the fixture does not supply is a NON-match.
 *
 * Prisma is mocked, so `job.findFirst` - the query EVERY per-instance scope check runs - answers
 * whatever the test told it to, for any `where` at all. A blanket `mockResolvedValue({ id })`
 * therefore makes every scope check pass and every "is refused" assertion vacuous. Pair this with
 * `mockScopedFindFirst` when a test's subject is authorization rather than the handler's body.
 *
 * THROWS on a shape it does not know, deliberately: a silent `true` on an unrecognised fragment is
 * exactly how a scope check gets to look enforced while being inert.
 */
export function matchesScopeWhere(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Record<string, unknown>[]).every((f) => matchesScopeWhere(f, row));
    if (key === 'OR') return (value as Record<string, unknown>[]).some((f) => matchesScopeWhere(f, row));
    if (key === 'NOT') return !matchesScopeWhere(value as Record<string, unknown>, row);

    const actual = row[key];

    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      // MATCH_NOTHING is `{ id: { in: [] } }` - no grant for the action, so nothing matches.
      if ('in' in obj) return (obj.in as unknown[]).includes(actual);
      // To-many relation: `{ some: {...} }`.
      if ('some' in obj) {
        return (
          Array.isArray(actual) &&
          actual.some((r) => matchesScopeWhere(obj.some as Record<string, unknown>, r as Record<string, unknown>))
        );
      }
      // To-one relation: recurse. A missing relation on the fixture is a non-match, never a match.
      if (Object.keys(obj).every((k) => /^[a-z_]+$/.test(k))) {
        return !!actual && matchesScopeWhere(obj, actual as Record<string, unknown>);
      }
      throw new Error(`matchesScopeWhere: unhandled operator object on "${key}": ${JSON.stringify(obj)}`);
    }

    return actual === value;
  });
}

/** Wire a mocked delegate's `findFirst` to really evaluate the scope fragment against `row`. */
export function mockScopedFindFirst(
  findFirst: ReturnType<typeof vi.fn>,
  row: Record<string, unknown>,
) {
  findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
    Promise.resolve(matchesScopeWhere(where, row) ? { id: row.id } : null),
  );
}

/**
 * Returns auth header object for use with supertest .set()
 */
export function authHeader(userKey: TestUserKey) {
  return { Authorization: `Bearer fake-token-${userKey}` };
}

// ─── Test Fixtures ──────────────────────────────────

export const CUSTOMER_FIXTURE = {
  id: 'c0000000-0000-0000-0000-000000000001',
  first_name: 'John',
  last_name: 'Doe',
  company_name: 'Doe HVAC',
  email: 'john@doe.com',
  phone: '5551234567',
  phone_ext: null,
  secondary_phone: null,
  secondary_phone_ext: null,
  ad_source: 'Google',
  allow_billing: false,
  tax_exempt: false,
  payment_type: null,
  extra_emails: [],
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

export const LOCATION_FIXTURE = {
  id: 'b0000000-0000-0000-0000-000000000001',
  customer_id: CUSTOMER_FIXTURE.id,
  address_line1: '123 Main St',
  address_line2: null,
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  is_primary: true,
};

export const LEAD_FIXTURE = {
  id: 'e0000000-0000-0000-0000-000000000001',
  lead_number: 'L00001',
  customer_id: CUSTOMER_FIXTURE.id,
  status: 'NEW',
  service_request: 'AC not cooling',
  job_type: null,
  scheduled_start: null,
  scheduled_end: null,
  service_address_line1: '123 Main St',
  service_address_line2: null,
  service_city: 'Austin',
  service_state: 'TX',
  service_zip: '78701',
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  walkthrough_notes: null,
  walkthrough_cancelled_at: null,
  walkthrough_cancelled_reason: null,
  walkthrough_cancelled_by: null,
  walkthrough_duration_minutes: null,
  contacted_at: null,
  contacted_note: null,
  cancelled_at: null,
  cancelled_reason: null,
  notes: null,
  lost_at: null,
  lost_reason: null,
  created_at: new Date('2026-01-15'),
  updated_at: new Date('2026-01-15'),
  customer: {
    id: CUSTOMER_FIXTURE.id,
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    email: 'john@doe.com',
    phone: '5551234567',
    phone_ext: null,
    service_locations: [LOCATION_FIXTURE],
  },
  // Scheduler redesign: the SINGLE owner is mirrored into one lead_assignees row; the
  // walkthrough performer set is MULTI (empty by default). The row-level CASL Owned-scope
  // condition evaluates `lead_assignees: { some: { user_id } }` in-memory, so the fixture
  // carries the mirror row matching the owner (TEST_USERS.sales.id).
  commission_owner_id: TEST_USERS.sales.id,
  commission_owner: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales', email: 'sales@test.com' },
  lead_assignees: [{ user_id: TEST_USERS.sales.id }],
  visit_assignees: [],
  walkthrough_customer_email_sent_at: null,
  // Walkthrough-as-entity redesign, PR-B2: defensive default for the leadListSelect/
  // leadDetailSelect `walkthroughs` relation the SELECT-site fix now reads (resolveCurrentWalkthrough
  // treats an absent/empty array as "no current visit", same as a fresh pre-redesign lead with every
  // legacy walkthrough_* column null). Individual tests override with real Walkthrough rows via
  // `mockPrisma.visit.findFirst`/`findMany` as needed - this is only a safe empty default.
  visits: [],
  estimates: [],
};

export const TAG_FIXTURE = {
  id: 'a0000000-0000-0000-0000-000000000001',
  name: 'Urgent',
  color: '#EF4444',
  created_at: new Date('2026-01-01'),
};

export const ESTIMATE_FIXTURE = {
  id: 'f0000000-0000-0000-0000-000000000001',
  organization_id: ALPHA_ORG_ID,
  lead_id: LEAD_FIXTURE.id,
  estimate_number: 'E00001',
  status: 'DRAFT',
  sent_at: null,
  approved_at: null,
  declined_at: null,
  expired_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  scope_notes: 'Replace AC unit',
  tax_rate: 0.0625,
  subtotal: 1000,
  tax_amount: 62.5,
  total_amount: 1062.5,
  public_token: null,
  created_by: TEST_USERS.sales.id,
  created_at: new Date('2026-01-20'),
  updated_at: new Date('2026-01-20'),
  lead: {
    id: LEAD_FIXTURE.id,
    status: 'CONTACTED',
    service_request: 'AC not cooling',
    service_address_line1: '123 Main St',
    service_address_line2: null,
    service_city: 'Austin',
    service_state: 'TX',
    service_zip: '78701',
    // Scheduler redesign: SALES row-scope reads the M2M owner set (lead_assignees),
    // mirrored to the single owner (TEST_USERS.sales.id).
    lead_assignees: [{ user_id: TEST_USERS.sales.id }],
    customer: {
      id: CUSTOMER_FIXTURE.id,
      first_name: 'John',
      last_name: 'Doe',
      company_name: 'Doe HVAC',
      email: 'john@doe.com',
      phone: '5551234567',
      service_locations: [{
        address_line1: '123 Main St',
        address_line2: null,
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      }],
    },
  },
  creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
  line_items: [
    {
      id: 'li000000-0000-0000-0000-000000000001',
      sequence: 1,
      description: 'AC Unit replacement',
      quantity: 1,
      unit_price: 800,
      is_taxable: true,
      line_total: 800,
    },
    {
      id: 'li000000-0000-0000-0000-000000000002',
      sequence: 2,
      description: 'Labor',
      quantity: 1,
      unit_price: 200,
      is_taxable: true,
      line_total: 200,
    },
  ],
  signature_data: null,
  signature_ip: null,
  signature_at: null,
};

export const ESTIMATE_SENT_FIXTURE = {
  ...ESTIMATE_FIXTURE,
  id: 'f0000000-0000-0000-0000-000000000002',
  estimate_number: 'E00002',
  status: 'SENT',
  sent_at: new Date('2026-01-21'),
  public_token: 'test-public-token-123',
};

export const STATE_TAX_FIXTURE = {
  id: 'st000000-0000-0000-0000-000000000001',
  state_code: 'TX',
  state_name: 'Texas',
  tax_rate: 0.0625,
};

export const ESTIMATE_APPROVED_FIXTURE = {
  ...ESTIMATE_FIXTURE,
  id: 'f0000000-0000-0000-0000-000000000003',
  estimate_number: 'E00003',
  status: 'APPROVED',
  approved_at: new Date('2026-01-22'),
};

export const JOB_FIXTURE = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  customer_id: CUSTOMER_FIXTURE.id,
  service_location_id: LOCATION_FIXTURE.id,
  estimate_id: ESTIMATE_APPROVED_FIXTURE.id,
  amount_invoiced: 0,
  status: 'UNSCHEDULED',
  scope_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  estimated_duration: null,
  completion_notes: null,
  created_at: new Date('2026-01-25'),
  updated_at: new Date('2026-01-25'),
  customer: {
    id: CUSTOMER_FIXTURE.id,
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    email: 'john@doe.com',
    phone: '5551234567',
  },
  // Multi-visit S8 (D6): crew lives on the VISIT. `assignees` survives as the payload key the
  // controller DERIVES from `visits`, so both are present here - reads of the wire key keep
  // working, and any select that asks for the relation gets the relation.
  assignees: [],
  visits: [] as Array<Record<string, unknown>>,
  service_location: {
    id: LOCATION_FIXTURE.id,
    address_line1: '123 Main St',
    address_line2: null,
    city: 'Austin',
    state: 'TX',
    zip: '78701',
  },
  estimate: {
    id: ESTIMATE_APPROVED_FIXTURE.id,
    estimate_number: 'E00003',
    total_amount: 1062.5,
    status: 'APPROVED',
    line_items: [],
  },
  customer_scheduled_email_sent_at: null,
  walkthrough_notes: null,
  walkthrough_completed_at: null,
  invoice: null,
};

// A standalone job: no estimate (DEC1 — urgent retired).
export const STANDALONE_JOB_FIXTURE = {
  ...JOB_FIXTURE,
  id: 'j0000000-0000-0000-0000-000000000003',
  job_number: 'J00003',
  estimate_id: null,
  estimate: null,
};

// A second, estimate-less/standalone job (id …002 / J00002). Distinct from STANDALONE_JOB_FIXTURE
// (id …003) above; kept for tests that need two independent estimate-less jobs.
export const STANDALONE_JOB_FIXTURE_2 = {
  ...JOB_FIXTURE,
  id: 'j0000000-0000-0000-0000-000000000002',
  job_number: 'J00002',
  estimate_id: null,
  estimate: null,
};

// Entity-redesign §4 — estimates are lead-linked (lead_id required). This fixture models a
// lead-linked estimate reached the one canonical way (estimate → lead → customer).
export const STANDALONE_ESTIMATE_FIXTURE = {
  id: 'e0000000-0000-0000-0000-000000000099',
  estimate_number: 'E00099',
  status: 'DRAFT',
  lead_id: LEAD_FIXTURE.id,
  lead: { id: LEAD_FIXTURE.id, status: 'NEW', customer: { id: CUSTOMER_FIXTURE.id, first_name: 'Test', last_name: 'Customer', company_name: null, email: 'c@example.com', phone: '5551234567' } },
  line_items: [],
  send_config: null,
  organization_id: ALPHA_ORG_ID,
};

// A plain line/charge data object (JobCharge model retired; used only for route-param ids
// and legacy charge-array assertions in a few specs).
export const JOB_CHARGE_FIXTURE = {
  id: 'jc000000-0000-0000-0000-000000000001',
  job_id: 'j0000000-0000-0000-0000-000000000002',
  sequence: 1,
  description: 'Emergency service fee',
  quantity: 1,
  unit_price: 150,
  is_taxable: true,
  line_total: 150,
};

// ─── Invoice Fixtures ────────────────────────────────

const INVOICE_JOB_NESTED = {
  id: JOB_FIXTURE.id,
  job_number: JOB_FIXTURE.job_number,
  status: 'COMPLETED',
  customer: {
    id: CUSTOMER_FIXTURE.id,
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    email: 'john@doe.com',
    phone: '5551234567',
  },
  service_location: {
    id: LOCATION_FIXTURE.id,
    address_line1: '123 Main St',
    address_line2: null,
    city: 'Austin',
    state: 'TX',
    zip: '78701',
  },
  estimate: {
    id: ESTIMATE_APPROVED_FIXTURE.id,
    estimate_number: 'E00003',
    subtotal: 2300,
    tax_rate: 0.08,
    tax_amount: 168,
    total_amount: 2468,
    line_items: [
      {
        id: 'li000000-0000-0000-0000-000000000001',
        sequence: 1,
        description: 'AC Unit replacement',
        quantity: 1,
        unit_price: 1800,
        is_taxable: true,
        line_total: 1800,
      },
      {
        id: 'li000000-0000-0000-0000-000000000002',
        sequence: 2,
        description: 'Labor',
        quantity: 1,
        unit_price: 500,
        is_taxable: true,
        line_total: 500,
      },
    ],
  },
};

export const INVOICE_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000901',
  invoice_number: 'I00001',
  job_id: JOB_FIXTURE.id,
  status: 'DRAFT',
  subtotal: 2300,
  discount_amount: 200,
  tax_amount: 168,
  deposit_credit: 1000,
  total_amount: 2268,
  amount_due: 1268,
  tip: 0,
  notes: null,
  public_token: null,
  sent_at: null,
  paid_at: null,
  created_by: TEST_USERS.admin.id,
  created_at: new Date('2026-02-01'),
  updated_at: new Date('2026-02-01'),
  job: INVOICE_JOB_NESTED,
  payments: [],
};

export const INVOICE_SENT_FIXTURE = {
  ...INVOICE_FIXTURE,
  id: '00000000-0000-0000-0000-000000000902',
  invoice_number: 'I00002',
  status: 'SENT',
  public_token: 'test-invoice-token-123',
  sent_at: new Date('2026-02-02'),
};

export const PAYMENT_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000951',
  invoice_id: INVOICE_SENT_FIXTURE.id,
  amount: 500,
  method: 'CHECK',
  reference_number: 'CHK-1234',
  notes: null,
  collected_by: TEST_USERS.technician.id,
  created_at: new Date('2026-02-03'),
};

export const INVOICE_PARTIAL_FIXTURE = {
  ...INVOICE_FIXTURE,
  id: '00000000-0000-0000-0000-000000000903',
  invoice_number: 'I00003',
  status: 'PARTIAL',
  amount_due: 768,
  payments: [PAYMENT_FIXTURE],
};

export const STANDALONE_INVOICE_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000904',
  invoice_number: 'I00004',
  job_id: STANDALONE_JOB_FIXTURE_2.id,
  status: 'DRAFT',
  subtotal: 150,
  discount_amount: 0,
  tax_amount: 12,
  deposit_credit: 0,
  total_amount: 162,
  amount_due: 162,
  notes: null,
  public_token: null,
  sent_at: null,
  paid_at: null,
  created_by: TEST_USERS.admin.id,
  created_at: new Date('2026-02-01'),
  updated_at: new Date('2026-02-01'),
  job: {
    id: STANDALONE_JOB_FIXTURE_2.id,
    job_number: STANDALONE_JOB_FIXTURE_2.job_number,
    status: 'COMPLETED',
    customer: {
      id: CUSTOMER_FIXTURE.id,
      first_name: 'John',
      last_name: 'Doe',
      company_name: 'Doe HVAC',
      email: 'john@doe.com',
      phone: '5551234567',
    },
    service_location: {
      id: LOCATION_FIXTURE.id,
      address_line1: '123 Main St',
      address_line2: null,
      city: 'Austin',
      state: 'TX',
      zip: '78701',
    },
    estimate: null,
  },
  payments: [],
};

// ─── Inventory Fixtures (Phase 1) ────────────────────────────
export const INVENTORY_LOCATION_FIXTURE = {
  id: 'aaaaaaa1-0000-0000-0000-000000000001',
  name: 'Main Warehouse',
  type: 'warehouse',
  organization_id: ALPHA_ORG_ID,
};
export const PRICE_BOOK_ITEM_FIXTURE = {
  id: 'aaaaaaa2-0000-0000-0000-000000000001',
  sku: 'LOCK-100',
  name: 'Deadbolt Lock',
  unit_cost: 20,
  unit_price: 40,
  sell_price: 40,
  uom: 'EA',
  track_inventory: false,
  organization_id: ALPHA_ORG_ID,
};
// A stock-tracked catalog item (P1 deduct-on-add / sync paths). Same org, distinct id.
export const TRACKED_ITEM_FIXTURE = {
  ...PRICE_BOOK_ITEM_FIXTURE,
  id: 'aaaaaaa2-0000-0000-0000-000000000002',
  sku: 'WIRE-12',
  name: '12ga Wire (ft)',
  track_inventory: true,
};
export const STOCK_BALANCE_FIXTURE = {
  id: 'aaaaaaa3-0000-0000-0000-000000000001',
  item_id: PRICE_BOOK_ITEM_FIXTURE.id,
  location_id: INVENTORY_LOCATION_FIXTURE.id,
  on_hand: 10,
  reserved: 0,
  organization_id: ALPHA_ORG_ID,
};
export const PURCHASE_ORDER_FIXTURE = {
  id: 'aaaaaaa4-0000-0000-0000-000000000001',
  po_number: 'PO-1001',
  vendor: 'Acme Supply',
  status: 'ordered',
  job_id: null,
  customer_id: null,
  customer: null,
  site: null,
  trade: null,
  ordered_at: new Date('2026-02-01'),
  expected_date: null,
  staged_as_job_stage_id: null,
  organization_id: ALPHA_ORG_ID,
  job: null,
  customer_rel: null,
  lines: [
    { id: 'aaaaaaa5-0000-0000-0000-000000000001', item_sku: 'LOCK-100', item_name: 'Deadbolt Lock', uom: 'EA', qty_ordered: 5, qty_received: 0, unit_cost: 20, price_book_item_id: null, created_at: new Date('2026-02-01') },
  ],
};
export const JOB_STAGE_FIXTURE = {
  id: 'aaaaaaa6-0000-0000-0000-000000000001',
  job_id: null,
  job_number: 'J00001',
  customer_id: null,
  customer: 'John Doe',
  site: '123 Main St',
  scheduled_for: null,
  assigned_tech_id: null,
  assigned_tech: null,
  trade: 'locksmith',
  status: 'awaiting_parts',
  pickup_vendor_id: null,
  pickup_address: null,
  staged_location_id: null,
  staged_area: null,
  notes: null,
  created_at: new Date('2026-02-01'),
  updated_at: new Date('2026-02-01'),
  organization_id: ALPHA_ORG_ID,
  job: null,
  customer_rel: null,
  items: [
    { id: 'aaaaaaa7-0000-0000-0000-000000000001', item_sku: 'LOCK-100', item_name: 'Deadbolt Lock', uom: 'EA', qty_ordered: 3, qty_received: 0, unit_cost: 20, vendor: 'Acme Supply', po_number: null, purchase_order_id: null, expected_date: null, serialized: false, received_serials: null, price_book_item_id: null, created_at: new Date('2026-02-01') },
  ],
  photos: [],
  audit_log: [],
};
export const BRAND_FIXTURE = {
  id: 'aaaaaaa8-0000-0000-0000-000000000001',
  name: 'Schlage',
  organization_id: ALPHA_ORG_ID,
};
export const ITEM_GROUP_FIXTURE = {
  id: 'aaaaaaa9-0000-0000-0000-000000000001',
  name: 'Door Hardware Kit',
  group_type: 'kit',
  is_active: true,
  organization_id: ALPHA_ORG_ID,
  lines: [],
};

// ─── Inventory Fixtures (Phase 4 — company-tool assets) ──────
export const ASSET_FIXTURE = {
  id: 'aaaaaab1-0000-0000-0000-000000000001',
  name: 'DeWalt Hammer Drill',
  serial: 'DW-4451',
  photo_url: null,
  price_book_item_id: null,
  status: 'ACTIVE',
  assigned_user_id: null,
  notes: null,
  created_at: new Date('2026-03-01'),
  updated_at: new Date('2026-03-01'),
  organization_id: ALPHA_ORG_ID,
  assigned_user: null,
  price_book_item: null,
};
export const ASSET_ASSIGNED_FIXTURE = {
  ...ASSET_FIXTURE,
  id: 'aaaaaab1-0000-0000-0000-000000000002',
  name: 'Makita Jigsaw',
  serial: 'MK-8890',
  assigned_user_id: TEST_USERS.technician.id,
  assigned_user: {
    id: TEST_USERS.technician.id,
    first_name: TEST_USERS.technician.first_name,
    last_name: TEST_USERS.technician.last_name,
  },
};
export const ASSET_RETIRED_FIXTURE = {
  ...ASSET_FIXTURE,
  id: 'aaaaaab1-0000-0000-0000-000000000003',
  name: 'Old Sawzall',
  serial: 'SZ-0001',
  status: 'RETIRED',
};

/**
 * The task-deletion service locks the rows it is about to delete (`SELECT id … FOR UPDATE`,
 * slice 11) and deletes only the ones still there. Against the mocked client, answer that lock
 * with the requested ids that `present` says still exist (all of them by default); a test for a
 * row deleted by a concurrent request passes `() => false`.
 */
export function stubTaskRowLocks(present: (id: string) => boolean = () => true) {
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation(async (_sql: unknown, ...values: unknown[]) => {
    const ids = values.find((v): v is string[] => Array.isArray(v)) ?? [];
    return ids.filter(present).map((id) => ({ id }));
  });
}

/**
 * Hand-built transaction clients for the lead visit doors need three more members now that every
 * visit write is followed by `syncLeadWalkthroughStatus`: the row lock (`$executeRaw`), the
 * lead's current status (`lead.findFirst`) and the open/finished visit counts (`visit.count`).
 * Wrap the object you were going to hand to the transaction callback in this and it gains
 * whichever of the three it lacks; anything the test already defined is kept.
 *
 * The defaults describe a lead that is Walkthrough Scheduled with one open visit, which is the
 * state the rule leaves alone, so a test that is about something else (the email, the location,
 * the performer roster) sees no status move and no extra History row. A test that IS about the
 * status passes the state it wants.
 */
export function withLeadStatusSync<T extends Record<string, any>>(
  tx: T,
  state: { status?: string; open?: number; finished?: number } = {},
): T {
  const { status = 'WALKTHROUGH_SCHEDULED', open = 1, finished = 0 } = state;
  const lead = (tx.lead ?? {}) as Record<string, unknown>;
  const visit = (tx.visit ?? {}) as Record<string, unknown>;
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    ...tx,
    lead: {
      // A transaction that already serves `lead.findUnique` (the row the test set up) is asked
      // for the status there, so the lead's state is stated in one place.
      findFirst: vi.fn().mockImplementation(async (args: unknown) =>
        typeof lead.findUnique === 'function' ? (lead.findUnique as (a: unknown) => unknown)(args) : { status }),
      ...lead,
    },
    visit: {
      count: vi.fn().mockImplementation(async ({ where }: { where: { status?: unknown } }) =>
        where.status === 'COMPLETED' ? finished : open),
      ...visit,
    },
  };
}
