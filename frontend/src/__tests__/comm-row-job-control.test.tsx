// Slice E3 — CommRowJobControl: the entity-tab attach / move / detach menu
// around a comm row's job pill. Contract under test:
//   • Gate = org comms access AND update:Communication AND channel call|sms|email
//     — any miss renders the static (nav/plain) pill. A missing customer is NOT
//     a miss any more: those rows get the picker in search mode.
//   • Attach: an unattributed row's menu lists the customer's OPEN jobs and
//     leads; picking PATCHes the channel's reassign endpoint.
//   • Leads are call-only — SMS/email have no lead endpoint, so no Leads group.
//   • Move: an attributed row's menu lists the OTHER open jobs (never the
//     currently attached one); picking PATCHes the new job_id.
//   • Detach: "No job or lead" PATCHes { job_id: null }.
//   • Success invalidates the hub + every entity timeline (job/customer/lead).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { CommRowJobControl } from '@/components/communication/shared/CommRowJobControl';
import type { CommItem } from '@/lib/api/jobCommunications';

const mockApi = vi.mocked(api);

// Org-level comms access — flipped per test (default ON; the matrix turns it off).
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Radix dropdown-menu internals touch scrollIntoView, which jsdom lacks.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// floating-ui (under Radix popper) does `new ResizeObserver(...)`; the global
// arrow-fn mock from setup.ts is not constructible, so override with a class.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const OPEN_JOB_A = 'b0000000-0000-0000-0000-000000000042';
const OPEN_JOB_B = 'b0000000-0000-0000-0000-000000000043';
const CLOSED_JOB = 'b0000000-0000-0000-0000-000000000017';

const OPEN_LEAD = 'd0000000-0000-0000-0000-000000000055';
const DEAD_LEAD = 'd0000000-0000-0000-0000-000000000056';

// Belongs to SOME OTHER customer: reachable only through the org-wide search,
// never through the open customer's own list. Proves the picker is not fenced
// in by the row's customer.
const ORG_JOB = 'b0000000-0000-0000-0000-000000000099';
const ORG_ONLY_JOBS = [
  { id: ORG_JOB, job_number: 'J00099', status: 'SCHEDULED', service_location: { address_line1: '9 Elsewhere Rd' } },
];

// Prod shape of GET /api/customers/:id → customer.jobs (useCustomerJobs seam).
const CUSTOMER_JOBS_FIXTURE = [
  { id: OPEN_JOB_A, job_number: 'J00042', status: 'SCHEDULED', service_location: { address_line1: '665 Fifth Ave' } },
  { id: OPEN_JOB_B, job_number: 'J00043', status: 'IN_PROGRESS', service_location: { address_line1: '1 Madison Ave' } },
  { id: CLOSED_JOB, job_number: 'J00017', status: 'CANCELLED', service_location: { address_line1: '30 Rockefeller Plaza' } },
];

// Prod shape of GET /api/leads → { leads: [...] } (useCustomerLeads/useLeadSearch).
const LEADS_FIXTURE = [
  { id: OPEN_LEAD, lead_number: 'L00055', status: 'NEW', service_request: 'No heat upstairs' },
  { id: DEAD_LEAD, lead_number: 'L00056', status: 'LOST', service_request: 'Went with a competitor' },
];

const UNATTRIBUTED_CALL: CommItem = {
  id: 'ca000000-0000-0000-0000-000000000001',
  channel: 'call',
  direction: 'in',
  who: 'Doe HVAC',
  title: 'Inbound call',
  preview: '',
  at: '2026-06-01T14:32:00.000Z',
};

const ATTRIBUTED_SMS: CommItem = {
  id: 'aa000000-0000-0000-0000-000000000001',
  channel: 'sms',
  direction: 'out',
  who: 'Doe HVAC',
  title: 'Text message',
  preview: 'Confirming Thursday 8am.',
  at: '2026-06-01T14:40:00.000Z',
  jobId: OPEN_JOB_A,
  jobLabel: 'J00042',
};

const ATTRIBUTED_EMAIL: CommItem = {
  id: 'ee000000-0000-0000-0000-000000000001',
  channel: 'email',
  direction: 'out',
  who: 'john@doe.com',
  title: 'Your estimate is ready',
  preview: 'Attached is estimate E00042.',
  at: '2026-06-01T14:45:00.000Z',
  jobId: OPEN_JOB_A,
  jobLabel: 'J00042',
};

const UNATTRIBUTED_EMAIL: CommItem = {
  id: 'ee000000-0000-0000-0000-000000000002',
  channel: 'email',
  direction: 'in',
  who: 'john@doe.com',
  title: 'Re: your estimate',
  preview: 'Looks good, go ahead.',
  at: '2026-06-01T15:05:00.000Z',
};

/**
 * Manual Communication Log (slice 5). Its channel is `call` — the API pins it, and there is no
 * picker until slice 6 — so it walks straight into the call branch of the gate below unless the
 * gate says otherwise. It must not: the menu PATCHes /api/communication/calls/:id/job, an
 * endpoint that resolves a CallSession, and a manual entry is not one.
 */
const MANUAL_ENTRY: CommItem = {
  id: '11110000-0000-0000-0000-000000000001',
  channel: 'call',
  direction: 'out',
  who: 'Doe HVAC',
  title: 'Outbound call · 12m',
  preview: 'Rang from my personal mobile about the quote.',
  at: '2026-06-01T14:00:00.000Z',
  jobId: OPEN_JOB_A,
  jobLabel: 'J00042',
  manuallyLogged: true,
  loggedByName: 'Dana Reyes',
};

const managerAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);

function renderControl(
  item: CommItem,
  { ability = managerAbility, customerId = CUSTOMER_ID }: { ability?: ReturnType<typeof buildAbility>; customerId?: string } = {}
) {
  return renderWithProviders(
    <CommRowJobControl item={item} customerId={customerId} />,
    { ability }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  commAccess.value = true;
  mockApi.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === `/api/customers/${CUSTOMER_ID}`)
      return { data: { customer: { jobs: CUSTOMER_JOBS_FIXTURE } } };
    // Serves both shapes: customer_id (the default list) and search (org-wide).
    if (url === '/api/leads') return { data: { leads: LEADS_FIXTURE } };
    if (url === '/api/jobs')
      return {
        data: {
          // The search endpoint spans the org, so it can return jobs the open
          // customer does not own — that is the point of it.
          jobs: [...CUSTOMER_JOBS_FIXTURE, ...ORG_ONLY_JOBS].filter((j) =>
            j.job_number.includes(String(config?.params?.search ?? ''))
          ),
        },
      };
    return { data: {} };
  });
  mockApi.patch.mockResolvedValue({ data: {} });
});

describe('CommRowJobControl — gating matrix', () => {
  it('renders the menu trigger for a gated call row', async () => {
    renderControl(UNATTRIBUTED_CALL);

    expect(await screen.findByTitle('Not attached — click to attach to a job or lead')).toBeInTheDocument();
  });

  it('without org comms access → static pill, no menu trigger, no jobs fetch', () => {
    commAccess.value = false;
    renderControl(ATTRIBUTED_SMS);

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    // Navigable static pill (chips align across tabs).
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${OPEN_JOB_A}`);
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('without update:Communication → static pill, no jobs fetch', () => {
    renderControl(ATTRIBUTED_SMS, { ability: readOnlyAbility });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  // Email gained its own per-row reassign seam (PATCH /emails/:id/job), so it
  // is now gated in alongside call/sms - the roll-ups are unified, and an email
  // that could not be re-attributed while the SMS beside it could was the odd
  // one out.
  it('renders the menu trigger for a gated email row', async () => {
    renderControl(ATTRIBUTED_EMAIL);

    expect(await screen.findByTitle('Attached to J00042 — click to move or detach')).toBeInTheDocument();
  });

  it('whatsapp rows still get no menu (no per-row reassign seam)', () => {
    renderControl({ ...ATTRIBUTED_SMS, channel: 'whatsapp' });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  // Manual Communication Log (slice 5): NOT re-attributable through this menu. The spec is
  // explicit that the attach/move/detach control drives a call-record-specific endpoint and is
  // not extended to manual entries — moving one between a lead and a job is done by editing it.
  //
  // The row below is otherwise a perfect match for the gate: channel `call`, comms access on,
  // update:Communication held. Only `manuallyLogged` keeps it out.
  it('a manually logged entry gets no menu, though its channel is call and the gate is otherwise open', () => {
    renderControl(MANUAL_ENTRY);

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/click to attach/)).not.toBeInTheDocument();
    // Static, navigable pill — the same treatment a whatsapp row gets.
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${OPEN_JOB_A}`);
    // ...and no target list is fetched for a menu that will never open.
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('an UNATTACHED manually logged entry gets no picker either', () => {
    const { jobId: _j, jobLabel: _l, ...unattached } = MANUAL_ENTRY;
    renderControl(unattached);

    expect(screen.queryByTitle(/click to attach/)).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  // Reversal of the original slice-E3 rule. A missing customer used to render a
  // dead pill, which meant the unknown-caller rows that most need manual
  // attribution were the only ones that could not get it — while the API accepted
  // the attach the whole time. They now get the picker, in search mode.
  it('without a customer scope → still a live menu, in search mode, fetching nothing until typed', async () => {
    // No customerId prop at all (the renderControl default would re-add it).
    renderWithProviders(<CommRowJobControl item={ATTRIBUTED_SMS} />, { ability: managerAbility });

    expect(await screen.findByTitle('Attached to J00042 — click to move or detach')).toBeInTheDocument();
    // Nothing to list without a customer, and below the search floor nothing is
    // fetched either — no customer list call, no unbounded org-wide list call.
    expect(mockApi.get).not.toHaveBeenCalled();
  });
});

describe('CommRowJobControl — attach / move / detach', () => {
  it('attach: lists OPEN jobs only and PATCHes the call reassign endpoint with { job_id }', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderControl(UNATTRIBUTED_CALL);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByTitle('Not attached — click to attach to a job or lead'));

    // Open jobs only — the CANCELLED one is never a target (COMPLETED jobs are valid targets).
    expect(await screen.findByRole('menuitem', { name: /J00042/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /J00043/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /J00017/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /J00042/ }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/calls/${UNATTRIBUTED_CALL.id}/job`,
        { job_id: OPEN_JOB_A }
      )
    );
    // Cross-surface sync: hub + all three entity timelines.
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['communication'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['job-communications'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-communications'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['lead-communications'] });
    });
  });

  it('move: the menu offers the OTHER open jobs (not the attached one); picking PATCHes the sms endpoint', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderControl(ATTRIBUTED_SMS);

    await user.click(await screen.findByTitle('Attached to J00042 — click to move or detach'));

    // The currently attached J00042 is not a move target; the other open job is.
    expect(await screen.findByRole('menuitem', { name: /J00043/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /J00042/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /J00017/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /J00043/ }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/sms/${ATTRIBUTED_SMS.id}/job`,
        { job_id: OPEN_JOB_B }
      )
    );
  });

  it('attach: an unattributed email PATCHes the email reassign endpoint with { job_id }', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderControl(UNATTRIBUTED_EMAIL);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByTitle('Not attached — click to attach to a job or lead'));
    await user.click(await screen.findByRole('menuitem', { name: /J00042/ }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/emails/${UNATTRIBUTED_EMAIL.id}/job`,
        { job_id: OPEN_JOB_A }
      )
    );
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['job-communications'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-communications'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['lead-communications'] });
    });
  });

  it('detach: "No job" on an attributed email PATCHes the email endpoint with { job_id: null }', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderControl(ATTRIBUTED_EMAIL);

    await user.click(await screen.findByTitle('Attached to J00042 — click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: 'No job or lead' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/emails/${ATTRIBUTED_EMAIL.id}/job`,
        { job_id: null }
      )
    );
  });

  it('detach: "No job" PATCHes { job_id: null } and invalidates the timelines', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderControl(ATTRIBUTED_SMS);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByTitle('Attached to J00042 — click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: 'No job or lead' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/sms/${ATTRIBUTED_SMS.id}/job`,
        { job_id: null }
      )
    );
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['lead-communications'] });
    });
  });
});

// The two gaps behind "why can't I attach a call to a job/lead?": leads were
// never offered anywhere despite the endpoint existing, and unknown callers got
// no control at all despite the API accepting them.
describe('CommRowJobControl — leads and unknown callers', () => {
  it('attach: a call row lists OPEN leads and PATCHes the lead endpoint with { lead_id }', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderControl(UNATTRIBUTED_CALL);

    await user.click(await screen.findByTitle('Not attached — click to attach to a job or lead'));

    expect(await screen.findByRole('menuitem', { name: /L00055/ })).toBeInTheDocument();
    // A LOST lead is never a target — the lead mirror of the CANCELLED job rule.
    expect(screen.queryByRole('menuitem', { name: /L00056/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /L00055/ }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/calls/${UNATTRIBUTED_CALL.id}/lead`,
        { lead_id: OPEN_LEAD }
      )
    );
  });

  it('sms rows get no Leads group (no lead endpoint to commit to)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderControl({ ...UNATTRIBUTED_CALL, channel: 'sms' });

    await user.click(await screen.findByTitle('Not attached — click to attach to a job or lead'));

    expect(await screen.findByRole('menuitem', { name: /J00042/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /L00055/ })).not.toBeInTheDocument();
  });

  it('unknown caller: typing searches org-wide and the pick still PATCHes the job endpoint', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<CommRowJobControl item={UNATTRIBUTED_CALL} />, { ability: managerAbility });

    await user.click(await screen.findByTitle('Not attached — click to attach to a job or lead'));
    await user.type(await screen.findByLabelText('Search jobs and leads'), 'J00043');

    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith('/api/jobs', {
        params: { search: 'J00043', limit: 8 },
      })
    );

    await user.click(await screen.findByRole('menuitem', { name: /J00043/ }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/calls/${UNATTRIBUTED_CALL.id}/job`,
        { job_id: OPEN_JOB_B }
      )
    );
  });

  // The picker used to fence a customer-scoped row into that customer's own
  // jobs and leads, with no search box at all — so a call attributed to the
  // wrong customer could never be moved, and the common case was the stuck one.
  it('known customer: seeds the default list but still searches the whole org', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderControl(UNATTRIBUTED_CALL);

    await user.click(await screen.findByTitle('Not attached — click to attach to a job or lead'));

    // Default list = this customer's own open jobs, before anything is typed.
    expect(await screen.findByRole('menuitem', { name: /J00042/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /J00099/ })).not.toBeInTheDocument();

    // ...and the search box is present, reaching past that customer.
    await user.type(await screen.findByLabelText('Search jobs and leads'), 'J00099');

    const orgHit = await screen.findByRole('menuitem', { name: /J00099/ });
    expect(screen.queryByRole('menuitem', { name: /J00042/ })).not.toBeInTheDocument();

    await user.click(orgHit);

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/calls/${UNATTRIBUTED_CALL.id}/job`,
        { job_id: ORG_JOB }
      )
    );
  });
});
