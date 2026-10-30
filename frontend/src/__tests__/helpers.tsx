import { ReactElement } from 'react';
import { vi } from 'vitest';
import api from '@/lib/axios';
import { render, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { buildAbility, type AppAbility } from '@/lib/ability';
import { NAV_REGISTRY, type NavGate } from '@/components/layout/nav-registry';

// ─── Test Query Client ────────────────────────────────────
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

// ─── Render with Providers ────────────────────────────────
interface WrapperOptions {
  initialEntries?: string[];
  /**
   * Optional CASL ability. When provided, children are wrapped in AbilityProvider
   * so ability-gated UI (e.g. force-purge, lead delete) can be exercised. When
   * omitted, useAppAbility() resolves to emptyAbility (all .can() === false),
   * matching the default deny-everything posture.
   */
  ability?: AppAbility;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderOptions & WrapperOptions
) {
  const { initialEntries = ['/'], ability, ...renderOptions } = options ?? {};
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: React.ReactNode }) {
    // App.tsx:69 wraps the entire route table in one KitTooltipProvider, so any
    // routed page may render a kit <Tooltip> without providing its own. Mirroring
    // that here keeps the harness honest: without it a page that tooltips
    // anything throws "`Tooltip` must be used within `TooltipProvider`" in the
    // test and works perfectly in the app, which is a harness defect reported as
    // a product one. Same delay as the app so nothing else diverges.
    const tree = (
      <QueryClientProvider client={queryClient}>
        <KitTooltipProvider delayDuration={320}>
          <MemoryRouter initialEntries={initialEntries}>
            {children}
          </MemoryRouter>
        </KitTooltipProvider>
      </QueryClientProvider>
    );
    return ability ? <AbilityProvider ability={ability}>{tree}</AbilityProvider> : tree;
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
    queryClient,
  };
}

// Roles & Permissions S02.19 - the sidebar draws its gated entries from the person's switches (`useMySwitches`), which
// arrive from the server. A suite whose subject is the shell around the menu rather than the menu itself seeds the
// last-known answer of a person who holds every switch a menu entry reads, so the entries are there on the first
// paint. The keys come from the registry's own gates, so a new gated entry is covered without editing this.
export function seedEveryMenuSwitch(userId: string): void {
  const values: Record<string, boolean> = {};
  const seed = (gate: NavGate | undefined) => {
    if (gate?.kind === 'record') { values[gate.view] = true; values[gate.show] = true; }
    if (gate?.kind === 'page') values[gate.access] = true;
    if (gate?.kind === 'show') values[gate.show] = true;
    if (gate?.kind === 'group' && gate.access) values[gate.access] = true;
  };
  for (const dest of NAV_REGISTRY) {
    seed(dest.gate);
    for (const child of dest.children ?? []) seed(child.gate);
  }
  localStorage.setItem(`servwave_my_switches:${userId}`, JSON.stringify({ values }));
}

// Roles & Permissions S07.13 - a page that draws a tab from a Show switch (display only, so not a rule) reads it from the
// person's own switches. A suite that mounts such a page with its data hooks stubbed seeds the last-known answer here,
// as `seedEveryMenuSwitch` does for the menu. The default test user's id is the one the shared auth mock hands out.
export function seedMySwitches(values: Record<string, boolean>, userId = '00000000-0000-0000-0000-000000000001'): void {
  localStorage.setItem(`servwave_my_switches:${userId}`, JSON.stringify({ values }));
}

// #2043 - the inventory module's ability-gated suites need a "holds every
// write verb, no `manage` row" ability. Exported once here so every
// converted suite (and the module's own ability-gate tests) build the same
// shape rather than re-deriving it per file. Deliberately excludes `manage`
// on any subject (R14) - a suite that needs to prove a gate is NOT keyed on
// the old wrong `manage Inventory` subject must build that ability itself.
export function inventoryWriteAbility(): AppAbility {
  return buildAbility([
    { action: 'read', subject: 'Inventory' },
    { action: 'create', subject: 'Inventory' },
    { action: 'update', subject: 'Inventory' },
    { action: 'delete', subject: 'Inventory' },
    // Roles & Permissions S07.1: a writer who sees every asset, as today (the holder filter and Assignee column show).
    { action: 'see_all_assets', subject: 'Inventory' },
    // Roles & Permissions S07.12: a writer who reads the movement history, as today (the Activity tab and item history show).
    { action: 'see_inventory_activity', subject: 'Inventory' },
    { action: 'read', subject: 'PriceBook' },
    { action: 'create', subject: 'PriceBook' },
    { action: 'update', subject: 'PriceBook' },
    { action: 'delete', subject: 'PriceBook' },
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'create', subject: 'PurchaseOrder' },
    { action: 'update', subject: 'PurchaseOrder' },
    { action: 'delete', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
    { action: 'create', subject: 'Vendor' },
    { action: 'update', subject: 'Vendor' },
    { action: 'delete', subject: 'Vendor' },
    { action: 'read', subject: 'LogisticOrder' },
    { action: 'create', subject: 'LogisticOrder' },
    { action: 'update', subject: 'LogisticOrder' },
    { action: 'delete', subject: 'LogisticOrder' },
  ]);
}

// Roles & Permissions S07.19 - the Purchase Orders and Vendors screens draw their controls from the person's own
// rules: Create, Edit and Delete of each, its Export, and See financial data (`read Pricing`) for every amount and the
// vendor account number. A suite whose subject is something other than who may do what mounts them with all of it.
export function purchasingAbility(): AppAbility {
  return buildAbility([
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'create', subject: 'PurchaseOrder' },
    { action: 'update', subject: 'PurchaseOrder' },
    { action: 'delete', subject: 'PurchaseOrder' },
    { action: 'export', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
    { action: 'create', subject: 'Vendor' },
    { action: 'update', subject: 'Vendor' },
    { action: 'delete', subject: 'Vendor' },
    { action: 'export', subject: 'Vendor' },
    { action: 'read', subject: 'Inventory' },
    { action: 'read', subject: 'Pricing' },
  ]);
}

// Roles & Permissions S07.21 - the Automations pages draw their controls from the person's own switches: New automation,
// Duplicate and the recipes from Create, the on/off switch, Publish and Test from Edit, Delete from Delete. A suite whose
// subject is something other than who may do what mounts them with every one of the four.
export function automationsManageAbility(): AppAbility {
  return buildAbility([
    { action: 'read', subject: 'Automation' },
    { action: 'create', subject: 'Automation' },
    { action: 'update', subject: 'Automation' },
    { action: 'delete', subject: 'Automation' },
  ]);
}

// #2046 - the Communication SECTION gate (`access_inbox Communication`). `useMessageThreads`,
// `useEmails`, `useWhatsAppChats` and `useCalls` all read this ability in their `enabled`
// expression, and it fails CLOSED outside a provider (`AbilityContext.tsx`'s `emptyAbility`), so
// any suite rendering those real hooks (directly, or through Header/V2AppLayout) needs one of
// these two shapes rather than an ad hoc rule list.
export function communicationSectionAbility(): AppAbility {
  return buildAbility([
    { action: 'read', subject: 'Communication' },
    { action: 'create', subject: 'Communication' },
    { action: 'access_inbox', subject: 'Communication' },
  ]);
}

// The SALES shape today: `read`/`create Communication` (the record-tab + compose/dial baseline)
// and NOTHING else — no section gate. Exported so a suite proving the gate FAILS CLOSED builds
// the exact grant shape the reproducer pins, rather than an emptyAbility that would also fail
// closed for unrelated reasons.
export function readOnlyCommunicationAbility(): AppAbility {
  return buildAbility([
    { action: 'read', subject: 'Communication' },
    { action: 'create', subject: 'Communication' },
  ]);
}

// ─── Fixtures ─────────────────────────────────────────────

/** Every action the server can list on a job (`job.actions`), for a test whose person may do anything on it. */
export const ALL_JOB_ACTIONS = [
  'edit', 'assign', 'schedule', 'complete', 'cancel', 'delete', 'duplicate',
  'create_invoice', 'create_estimate', 'renumber', 'edit_line_items', 'apply_discount', 'add_note', 'upload_attachment', 'log_communication',
];

export const LEAD_FIXTURE = {
  id: 'e0000000-0000-0000-0000-000000000001',
  lead_number: 'L00001',
  customer_id: 'c0000000-0000-0000-0000-000000000001',
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
  notes: null,
  lost_at: null,
  lost_reason: null,
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-15T00:00:00.000Z',
  // The lead's OWN anchor (entity-redesign §3/§10). Distinct from the customer roster below:
  // the roster is the customer's, this one address is the lead's.
  service_location_id: 'l0000000-0000-0000-0000-000000000001',
  service_location: {
    id: 'l0000000-0000-0000-0000-000000000001',
    address_line1: '123 Main St',
    address_line2: null,
    city: 'Austin',
    state: 'TX',
    zip: '78701',
  },
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    email: 'john@doe.com',
    phone: '5551234567',
    phone_ext: null,
    service_locations: [
      {
        id: 'l0000000-0000-0000-0000-000000000001',
        address_line1: '123 Main St',
        address_line2: null,
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        is_primary: true,
      },
    ],
  },
  // Scheduler redesign: SINGLE owner (commission_owner) + the M2M owner-mirror row.
  commission_owner: {
    id: '00000000-0000-0000-0000-000000000003',
    first_name: 'Test',
    last_name: 'Sales',
    email: 'sales@test.com',
  },
  lead_assignees: [
    { user_id: '00000000-0000-0000-0000-000000000003', user: { id: '00000000-0000-0000-0000-000000000003', first_name: 'Test', last_name: 'Sales' } },
  ],
  walkthrough_performers: [],
  estimates: [],
  tags: [],
};

export const LEAD_LIST_FIXTURE = {
  leads: [
    {
      id: LEAD_FIXTURE.id,
      status: 'NEW',
      service_request: 'AC not cooling',
      job_type: null,
      scheduled_start: null,
      created_at: '2026-01-15T00:00:00.000Z',
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
        phone: '5551234567',
        ad_source: null,
      },
      commission_owner: {
        id: '00000000-0000-0000-0000-000000000003',
        first_name: 'Test',
        last_name: 'Sales',
      },
      lead_assignees: [
        { user: { id: '00000000-0000-0000-0000-000000000003', first_name: 'Test', last_name: 'Sales' } },
      ],
      walkthrough_performers: [],
      tags: [],
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    total: 10,
    new_this_week: 3,
    unassigned: 1,
    won: 4,
    lost: 2,
  },
};

export const NOTES_FIXTURE = [
  {
    id: 'n0000000-0000-0000-0000-000000000001',
    content: 'Follow up with customer.',
    created_at: '2026-02-18T10:00:00.000Z',
    creator: { id: '00000000-0000-0000-0000-000000000001', first_name: 'Test', last_name: 'Admin' },
  },
];

export const TAGS_FIXTURE = [
  { id: 'a0000000-0000-0000-0000-000000000001', name: 'Urgent', color: '#EF4444' },
  { id: 'a0000000-0000-0000-0000-000000000002', name: 'VIP', color: '#8B5CF6' },
];

// ─── The home page's server layout (Roles & Permissions S09.4) ────────────────
// The dashboard page reads its layout from `GET /api/dashboard/layout` and saves it with `PUT` there, besides the
// dashboard answer itself. A suite that renders the page serves both through this: the layout starts as the factory
// layout unless a test gives one, and a save is remembered, so a second render reads back what the first one saved.
export interface ServedLayoutEntry {
  id: string;
  visible: boolean;
  size?: string;
  range?: string;
  /** `false` marks a stored tile the person cannot have right now (S09.7): kept in place, never drawn. */
  available?: false;
}

export const FACTORY_LAYOUT: ServedLayoutEntry[] = [
  'kpi.revenue_mtd', 'kpi.collected_today', 'kpi.recurring', 'kpi.ar', 'kpi.close_rate', 'kpi.jobs_today', 'kpi.open_leads',
  'kpi.avg_ticket', 'kpi.jobs_week', 'kpi.deposits', 'smart_insights', 'needs_attention', 'schedule_today', 'revenue_chart',
  'pipeline', 'tech_scoreboard', 'dispatch_scoreboard', 'lead_sources', 'revenue_by_job_type',
].map((id) => ({ id, visible: true }));

export function serveDashboard(
  answer: unknown,
  layout: ServedLayoutEntry[] = FACTORY_LAYOUT,
  roleDefault: ServedLayoutEntry[] = layout,
  /** `saved: false` is a person with no layout on the server yet (S09.5): the layout is then their role's default. */
  options: { saved?: boolean } = {},
) {
  const server = {
    layout: layout.map((e) => ({ ...e })),
    saved: options.saved ?? true,
    saves: [] as ServedLayoutEntry[][],
    carryOvers: [] as ServedLayoutEntry[][],
    /** How many times the person asked for their role's default back (S09.6). */
    resets: 0,
    layoutReads: 0,
  };
  const layoutAnswer = () => ({ layout: server.layout, saved: server.saved });
  vi.mocked(api.get).mockImplementation(((url: string) => {
    if (url === '/api/dashboard/layout') server.layoutReads += 1;
    return Promise.resolve({ data: url === '/api/dashboard/layout' ? layoutAnswer() : answer });
  }) as never);
  vi.mocked(api.put).mockImplementation(((url: string, payload: { layout: ServedLayoutEntry[] }) => {
    if (url !== '/api/dashboard/layout') return Promise.reject(new Error(`unexpected PUT ${url}`));
    server.layout = payload.layout;
    server.saved = true;
    server.saves.push(payload.layout);
    return Promise.resolve({ data: layoutAnswer() });
  }) as never);
  // The one-time carry-over of a browser layout stores it only when nothing is saved, as the real route does.
  vi.mocked(api.post).mockImplementation(((url: string, payload: { layout: ServedLayoutEntry[] }) => {
    // A reset replaces the saved layout with the role's default and keeps the row (`saved` stays true), as the real route does.
    if (url === '/api/dashboard/layout/reset') {
      server.resets += 1;
      server.layout = roleDefault.map((e) => ({ ...e }));
      server.saved = true;
      return Promise.resolve({ data: layoutAnswer() });
    }
    if (url !== '/api/dashboard/layout/carry-over') return Promise.reject(new Error(`unexpected POST ${url}`));
    server.carryOvers.push(payload.layout);
    if (!server.saved) {
      server.layout = payload.layout;
      server.saved = true;
    }
    return Promise.resolve({ data: layoutAnswer() });
  }) as never);
  return server;
}
