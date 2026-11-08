/**
 * Multi-visit S8 (behaviour 5) - the technician's job-page controls survive the OWN_JOB repoint.
 *
 * The client re-evaluates the SERVER'S stored row-scope condition in `satisfiesJobScope`, whose
 * `default` arm returns false. The moment that condition's top-level key becomes `visits`, every
 * row-scoped technician control on this page disappears with NO error - and because ADMIN and
 * DISPATCHER grants are unconditional and match fine, an admin-principal smoke test stays green.
 * `canOnJob`'s own docstring names this exact failure mode, which is why the principal here is a
 * TECHNICIAN and the ability is built from the real post-S8 condition shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const TECH_ID = 'u0000000-0000-0000-0000-0000000000aa';
const OTHER_ID = 'u0000000-0000-0000-0000-0000000000bb';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

/** The post-S8 stored condition, byte-for-byte what role_permissions now holds. */
const OWN_JOB_VISITS = { visits: { some: { assignees: { some: { user_id: TECH_ID } } } } };

function technicianAbility() {
  return buildAbility([
    { action: 'read', subject: 'Job', conditions: { OR: [OWN_JOB_VISITS, { created_by_id: TECH_ID }] } } as never,
    { action: 'update', subject: 'Job', conditions: OWN_JOB_VISITS } as never,
    { action: 'start', subject: 'Job', conditions: OWN_JOB_VISITS } as never,
    { action: 'arrive', subject: 'Job', conditions: OWN_JOB_VISITS } as never,
    { action: 'reschedule', subject: 'Job', conditions: OWN_JOB_VISITS } as never,
  ]);
}

function visit(seq: number, crew: string[]) {
  return {
    id: `${JOB_ID}-v${seq}`,
    visit_seq: seq,
    status: 'SCHEDULED',
    purpose: 'WORK',
    scheduled_at: `2026-08-2${seq}T13:00:00.000Z`,
    scheduled_end: `2026-08-2${seq}T15:00:00.000Z`,
    is_all_day: false,
    en_route_at: null,
    on_site_at: null,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    customer_email_sent_at: null,
    notes: null,
    assignees: crew.map((u) => ({ user_id: u, user: { id: u, first_name: 'A', last_name: 'B' } })),
  };
}

function mount({ visitCrew }: { visitCrew: string[][] }) {
  const visits = visitCrew.map((crew, i) => visit(i + 1, crew));
  const job = {
    id: JOB_ID,
    job_number: 'J00001',
    status: 'SCHEDULED',
    scope_notes: null,
    estimated_duration: null,
    completion_notes: null,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    created_by_id: OTHER_ID,
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    // The wire key survives the relation move as the visit-derived union (behaviour 6).
    assignees: [...new Set(visitCrew.flat())].map((u) => ({ user: { id: u, first_name: 'A', last_name: 'B' } })),
    visits,
    service_location: null,
    estimate: null,
    invoices: [],
    linked_estimates: [],
    tags: [],
    source_plan_id: null,
    source_plan: null,
  };

  vi.mocked(api).get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });

  return renderWithProviders(<JobDetailPage />, { ability: technicianAbility() });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: TECH_ID, email: 't@t.com', first_name: 'Tess', last_name: 'Tech', role: 'TECHNICIAN' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
});

describe('S8 - a technician crewed through a visit keeps the controls the API will honour', () => {
  it('offers the visit-2 lifecycle controls to a technician crewed on visit 2 only', async () => {
    mount({ visitCrew: [[OTHER_ID], [TECH_ID]] });

    await screen.findByText('J00001');
    // canOnJob answers per JOB, not per visit, so the observable fact is that the page offers
    // the per-visit lifecycle controls at all. "Mark on site" is the rail's own primary-step label.
    // The lifecycle rail's per-visit control. Two visits, so two of them.
    expect((await screen.findAllByRole('button', { name: /^mark on site$/i })).length).toBe(2);
  });

  it('offers the per-visit Reschedule control for that same technician', async () => {
    // `reschedule Job` is a per-user capability, and its own condition is the same OWN_JOB
    // shape - so this is the second verb whose scope has to survive the repoint, and the
    // control it gates is the one a technician actually reaches for.
    mount({ visitCrew: [[OTHER_ID], [TECH_ID]] });

    await screen.findByText('J00001');
    await userEvent.click(screen.getByRole('tab', { name: /visits/i }));
    expect((await screen.findAllByRole('button', { name: /^reschedule$/i })).length).toBeGreaterThan(0);
  });

  it('offers none of them to a technician crewed on no visit of the job', async () => {
    mount({ visitCrew: [[OTHER_ID], [OTHER_ID]] });

    await screen.findByText('J00001');
    expect(screen.queryAllByRole('button', { name: /^mark on site$/i })).toHaveLength(0);

    await userEvent.click(screen.getByRole('tab', { name: /visits/i }));
    expect((await screen.findAllByText('Visit 2')).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: /^reschedule$/i })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^start work$/i })).toHaveLength(0);
  });
});
