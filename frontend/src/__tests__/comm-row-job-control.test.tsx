// Slice E3 — CommRowJobControl: the entity-tab attach / move / detach menu
// around a comm row's job pill. Contract under test:
//   • Gate = org comms access AND attach:Communication (the Attach conversations to jobs and leads
//     switch, not Edit communication records) AND channel call|sms|email
//     — any miss renders the static (nav/plain) pill. A missing customer is NOT
//     a miss any more: those rows get the picker in search mode.
//   • Attach: an unattributed row's menu lists OPEN jobs and leads; picking PATCHes the channel's reassign endpoint.
//     A text's or a call's menu is "Attach to a lead or job" (#3024): what the server offers for its number (the
//     leads and jobs of the customers carrying it, or a search of every one when none does). An email's lists the
//     customer's own, with a search of the whole company.
//   • Jobs and leads are targets for calls, texts and emails alike (S08.19), each with its own lead endpoint.
//   • Move: an attributed row's menu lists the OTHER open jobs (never the
//     currently attached one); picking PATCHes the new job_id.
//   • Detach: "No job or lead" PATCHes { job_id: null } (and { lead_id: null } for a row that also sits on a lead).
//   • A detach that takes the row out of the person's reach is a quiet success, never an error toast.
//   • Success invalidates the hub + every entity timeline (job/customer/lead).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/components/ui/use-toast';
import { CommRowJobControl } from '@/components/communication/shared/CommRowJobControl';
import type { CommItem } from '@/lib/api/jobCommunications';
import { MY_SWITCHES_URL, VIEWS_CUSTOMERS_ANSWER } from './support/viewsCustomers';

const mockApi = vi.mocked(api);

// Org-level comms access — flipped per test (default ON; the matrix turns it off).
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

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

/** A call from a number no customer carries (#3024: any lead or job, by search). */
const UNKNOWN_CALLER_ID = 'ca000000-0000-0000-0000-000000000009';

/** What "Attach to a lead or job" offers for a text or a call (#3024): the server leaves the cancelled job and the lost lead out. */
const CARRIERS_ANSWER = {
  rule: 'carriers',
  groups: [{
    customer: { id: CUSTOMER_ID, name: 'Pat Morgan' },
    jobs: [
      { id: OPEN_JOB_A, number: 'J00042', location: '665 Fifth Ave' },
      { id: OPEN_JOB_B, number: 'J00043', location: '1 Madison Ave' },
    ],
    leads: [{ id: OPEN_LEAD, number: 'L00055', detail: 'No heat upstairs' }],
  }],
};

/** The detach item: "No lead or job" in a text's or a call's menu (#3024), "No job or lead" in an email's. */
const detachItem = (channel: string) => (channel === 'email' ? 'No job or lead' : 'No lead or job');

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
  { action: 'attach', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);
// Edit communication records without Attach conversations to jobs and leads: the server refuses the attach.
const editOnlyAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

function renderControl(
  item: CommItem,
  { ability = managerAbility, customerId = CUSTOMER_ID }: { ability?: ReturnType<typeof buildAbility>; customerId?: string } = {}
) {
  return renderWithProviders(
    <CommRowJobControl item={item} customerId={customerId} />,
    { ability }
  );
}

/** The person's own switches are read on the way; nothing else may be asked for. */
const fetchesOtherThanMySwitches = () => mockApi.get.mock.calls.filter(([url]) => url !== MY_SWITCHES_URL);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  commAccess.value = true;
  mockApi.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === MY_SWITCHES_URL) return VIEWS_CUSTOMERS_ANSWER;
    if (url === `/api/communication/calls/${UNKNOWN_CALLER_ID}/attach-targets`) return { data: { rule: 'any', groups: [] } };
    if (/^\/api\/communication\/(sms|calls)\/[^/]+\/attach-targets$/.test(url)) return { data: CARRIERS_ANSWER };
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

    expect(await screen.findByTitle('Not attached - click to attach to a job or lead')).toBeInTheDocument();
  });

  it('without org comms access → static pill, no menu trigger, no jobs fetch', () => {
    commAccess.value = false;
    renderControl(ATTRIBUTED_SMS);

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    // Navigable static pill (chips align across tabs).
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${OPEN_JOB_A}`);
    expect(fetchesOtherThanMySwitches()).toEqual([]);
  });

  it('without attach:Communication → static pill, no jobs fetch', () => {
    renderControl(ATTRIBUTED_SMS, { ability: readOnlyAbility });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    expect(fetchesOtherThanMySwitches()).toEqual([]);
  });

  it('with only update:Communication (Edit communication records) → static pill, no jobs fetch', () => {
    renderControl(ATTRIBUTED_SMS, { ability: editOnlyAbility });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    expect(fetchesOtherThanMySwitches()).toEqual([]);
  });

  // Email gained its own per-row reassign seam (PATCH /emails/:id/job), so it
  // is now gated in alongside call/sms - the roll-ups are unified, and an email
  // that could not be re-attributed while the SMS beside it could was the odd
  // one out.
  it('renders the menu trigger for a gated email row', async () => {
    renderControl(ATTRIBUTED_EMAIL);

    expect(await screen.findByTitle('Attached to J00042 - click to move or detach')).toBeInTheDocument();
  });

  it('whatsapp rows still get no menu (no per-row reassign seam)', () => {
    renderControl({ ...ATTRIBUTED_SMS, channel: 'whatsapp' });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    expect(fetchesOtherThanMySwitches()).toEqual([]);
  });

  // Manual Communication Log (slice 5): NOT re-attributable through this menu. The spec is
  // explicit that the attach/move/detach control drives a call-record-specific endpoint and is
  // not extended to manual entries — moving one between a lead and a job is done by editing it.
  //
  // The row below is otherwise a perfect match for the gate: channel `call`, comms access on,
  // attach:Communication held. Only `manuallyLogged` keeps it out.
  it('a manually logged entry gets no menu, though its channel is call and the gate is otherwise open', () => {
    renderControl(MANUAL_ENTRY);

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.queryByTitle(/click to move or detach/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/click to attach/)).not.toBeInTheDocument();
    // Static, navigable pill — the same treatment a whatsapp row gets.
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${OPEN_JOB_A}`);
    // ...and no target list is fetched for a menu that will never open.
    expect(fetchesOtherThanMySwitches()).toEqual([]);
  });

  it('an UNATTACHED manually logged entry gets no picker either', () => {
    const { jobId: _j, jobLabel: _l, ...unattached } = MANUAL_ENTRY;
    renderControl(unattached);

    expect(screen.queryByTitle(/click to attach/)).not.toBeInTheDocument();
    expect(fetchesOtherThanMySwitches()).toEqual([]);
  });

  // Reversal of the original slice-E3 rule. A missing customer used to render a
  // dead pill, which meant the unknown-caller rows that most need manual
  // attribution were the only ones that could not get it — while the API accepted
  // the attach the whole time. They now get the picker, in search mode.
  it('without a customer scope → still a live menu, in search mode, fetching nothing until typed', async () => {
    // No customerId prop at all (the renderControl default would re-add it).
    renderWithProviders(<CommRowJobControl item={ATTRIBUTED_SMS} />, { ability: managerAbility });

    expect(await screen.findByTitle('Attached to J00042 - click to move or detach')).toBeInTheDocument();
    // Nothing to list without a customer, and below the search floor nothing is
    // fetched either — no customer list call, no unbounded org-wide list call.
    expect(fetchesOtherThanMySwitches()).toEqual([]);
  });
});

describe('CommRowJobControl — attach / move / detach', () => {
  it('attach: lists OPEN jobs only and PATCHes the call reassign endpoint with { job_id }', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderControl(UNATTRIBUTED_CALL);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByTitle('Not attached - click to attach to a job or lead'));

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

    await user.click(await screen.findByTitle('Attached to J00042 - click to move or detach'));

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

    await user.click(await screen.findByTitle('Not attached - click to attach to a job or lead'));
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

    await user.click(await screen.findByTitle('Attached to J00042 - click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: 'No job or lead' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/emails/${ATTRIBUTED_EMAIL.id}/job`,
        { job_id: null }
      )
    );
  });

  it('detach: "No lead or job" on a text PATCHes { job_id: null } and invalidates the timelines', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderControl(ATTRIBUTED_SMS);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByTitle('Attached to J00042 - click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: 'No lead or job' }));

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

    await user.click(await screen.findByTitle('Not attached - click to attach to a job or lead'));

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

  it.each([
    ['sms', 'sms', 'messageId'],
    ['email', 'emails', 'emailId'],
  ] as const)('attach: a %s row lists OPEN leads and PATCHes its own lead endpoint with { lead_id }', async (channel, segment) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const row = { ...UNATTRIBUTED_CALL, channel };
    renderControl(row);

    await user.click(await screen.findByTitle('Not attached - click to attach to a job or lead'));

    expect(await screen.findByRole('menuitem', { name: /J00042/ })).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: /L00055/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /L00056/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /L00055/ }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(`/api/communication/${segment}/${row.id}/lead`, { lead_id: OPEN_LEAD })
    );
    expect(mockApi.patch).not.toHaveBeenCalledWith(expect.stringMatching(/\/job$/), expect.anything());
  });

  it('unknown caller (no customer carries the number): typing searches org-wide and the pick still PATCHes the job endpoint', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const unknown = { ...UNATTRIBUTED_CALL, id: UNKNOWN_CALLER_ID };
    renderWithProviders(<CommRowJobControl item={unknown} />, { ability: managerAbility });

    await user.click(await screen.findByTitle('Not attached - click to attach to a job or lead'));
    await user.type(await screen.findByLabelText('Search leads and jobs'), 'J00043');

    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith('/api/jobs', {
        // Done jobs are reachable here: the Jobs list's default view leaves them out, this search asks for them.
        params: { search: 'J00043', limit: 8, include_done: 'true' },
      })
    );

    await user.click(await screen.findByRole('menuitem', { name: /J00043/ }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        `/api/communication/calls/${UNKNOWN_CALLER_ID}/job`,
        { job_id: OPEN_JOB_B }
      )
    );
  });

  // #3024 (Ran, 2026-11-06, ruling 1): a call whose number some customer carries may be tied only to the leads and jobs of
  // those customers; the menu lists them and its search stays within them (the server refuses anything else).
  it('a call whose number customers carry: lists only their leads and jobs, and the search stays within them', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderControl(UNATTRIBUTED_CALL);

    await user.click(await screen.findByTitle('Not attached - click to attach to a job or lead'));
    expect(await screen.findByRole('menuitem', { name: /J00042/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Pat Morgan' })).toBeInTheDocument();

    await user.type(await screen.findByLabelText('Search leads and jobs'), 'J00099');
    expect(await screen.findByText('No matching leads or jobs')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /J00099/ })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/jobs', expect.anything());
  });
});

describe('CommRowJobControl — detaching a text or an email that also sits on a lead', () => {
  it('an email row on a job and a lead clears both ends, the lead first', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const row = { ...ATTRIBUTED_SMS, channel: 'email' as const, leadId: OPEN_LEAD, leadLabel: 'L00055' };
    renderControl(row);

    await user.click(await screen.findByTitle('Attached to J00042 - click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: detachItem('email') }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(2));
    expect(mockApi.patch.mock.calls[0]).toEqual([`/api/communication/emails/${row.id}/lead`, { lead_id: null }]);
    expect(mockApi.patch.mock.calls[1]).toEqual([`/api/communication/emails/${row.id}/job`, { job_id: null }]);
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith({ title: 'Link removed' }));
  });

  // #3024 (Ran, 2026-11-06): the server keeps a text on one record, so "No lead or job" is one change that clears both ends.
  it('a text row on a job and a lead clears both ends in one change', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const row = { ...ATTRIBUTED_SMS, leadId: OPEN_LEAD, leadLabel: 'L00055' };
    renderControl(row);

    await user.click(await screen.findByTitle('Attached to J00042 - click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: detachItem('sms') }));

    await waitFor(() => expect(toast).toHaveBeenLastCalledWith({ title: 'Link removed' }));
    expect(mockApi.patch.mock.calls).toEqual([[`/api/communication/sms/${row.id}/job`, { job_id: null }]]);
  });

  it('a row that sits on a lead only clears just the lead', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { jobId: _j, jobLabel: _l, ...noJob } = ATTRIBUTED_EMAIL;
    const row = { ...noJob, leadId: OPEN_LEAD, leadLabel: 'L00055' };
    renderControl(row);

    await user.click(await screen.findByTitle('Not attached - click to attach to a job or lead'));
    await user.click(await screen.findByRole('menuitem', { name: 'No job or lead' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith(`/api/communication/emails/${row.id}/lead`, { lead_id: null });
  });
});

describe('CommRowJobControl — a detach that takes the row out of the person\'s reach', () => {
  it.each([
    ['call', 'calls'],
    ['sms', 'sms'],
    ['email', 'emails'],
  ] as const)('a %s is a quiet success: one plain note, no error toast', async (channel, segment) => {
    mockApi.patch.mockResolvedValue({ data: { [channel === 'sms' ? 'message' : channel]: null, left: true } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const row = { ...ATTRIBUTED_SMS, channel };
    renderControl(row);

    await user.click(await screen.findByTitle('Attached to J00042 - click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: detachItem(channel) }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith(`/api/communication/${segment}/${row.id}/job`, { job_id: null }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const shown = vi.mocked(toast).mock.calls[0]![0] as { title: string; variant?: string };
    expect(shown.variant).toBeUndefined();
    expect(shown.title).toMatch(/no longer in your list/i);
  });

  it('stops after the lead step when that step already took the row out of reach', async () => {
    mockApi.patch.mockResolvedValue({ data: { email: null, left: true } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const row = { ...ATTRIBUTED_EMAIL, leadId: OPEN_LEAD, leadLabel: 'L00055' };
    renderControl(row);

    await user.click(await screen.findByTitle('Attached to J00042 - click to move or detach'));
    await user.click(await screen.findByRole('menuitem', { name: 'No job or lead' }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0]![0]).not.toHaveProperty('variant');
  });
});
