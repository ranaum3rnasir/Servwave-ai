import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';

const mockApi = vi.mocked(api);

// Comms access gate — default OFF (matches the auth store's test default) so the
// existing timeline specs render the read-only surface; the drawer spec flips it.
const commAccess = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Stub the detail drawer (it lazy-loads the CallsView/Dialer graph) so this spec
// stays on the tab's wiring.
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({
  EntityCallDrawer: ({ callId, onClose }: { callId: string; onClose: () => void }) => (
    <div data-testid="entity-call-drawer" data-call-id={callId}>
      <button type="button" onClick={onClose}>
        close-drawer
      </button>
    </div>
  ),
}));

vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({
  EntitySmsDrawer: ({ threadId, onClose }: { threadId: string; onClose: () => void }) => (
    <div data-testid="entity-sms-drawer" data-thread-id={threadId}>
      <button type="button" onClick={onClose}>
        close-sms-drawer
      </button>
    </div>
  ),
}));

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
// #2046 (R1) - the row's own thread id, the drawer's new key.
const THREAD_ID = 'sm-00000000-0000-0000-0000-000000000099';

// Shared CommItem contract fixtures — 3 channels, ascending by `at` (the
// backend's order). The SMS row carries no job → muted "no job" pill.
const ITEMS = [
  {
    id: 'cs-00000000-0000-0000-0000-000000000001',
    channel: 'call',
    direction: 'in',
    who: 'Maria Garcia',
    title: 'Inbound call · 4m 07s',
    preview: 'Asked about rescheduling the vault corridor work.',
    at: '2026-06-01T14:00:00.000Z',
    jobId: 'b0000000-0000-0000-0000-000000000001',
    jobLabel: 'J00018',
    meta: 'Answered',
  },
  {
    id: 'em-00000000-0000-0000-0000-000000000001',
    channel: 'email',
    direction: 'out',
    who: 'Maria Garcia',
    title: 'Estimate E00012 — ready for review',
    preview: 'Hi Maria, your estimate is ready for review…',
    at: '2026-06-02T09:30:00.000Z',
    jobId: 'b0000000-0000-0000-0000-000000000001',
    jobLabel: 'J00018',
    transactional: true,
  },
  {
    id: 'sm-00000000-0000-0000-0000-000000000001',
    channel: 'sms',
    direction: 'in',
    who: 'Maria Garcia',
    title: 'Text message',
    preview: 'Sounds good, see you then!',
    at: '2026-06-03T16:45:00.000Z',
    threadId: THREAD_ID,
  },
];

// A hand-logged entry (manual communication log). Its channel is `call` - that is what the
// logger recorded - but its id belongs to manual_communication_logs, not call_sessions.
const LOGGED_CALL_ITEM = {
  id: '11110000-0000-0000-0000-000000000011',
  channel: 'call',
  direction: 'out',
  who: 'Maria Garcia',
  title: 'Outbound call',
  preview: 'Rang Maria from my mobile about the corridor work.',
  at: '2026-06-04T10:00:00.000Z',
  manuallyLogged: true,
  loggedByName: 'Test Admin',
};

// C6b - the same defect on a different channel: a logged TEXT's arm opens the customer's REAL
// SMS thread, a conversation this entry was never part of.
const LOGGED_TEXT_ITEM = {
  id: '11110000-0000-0000-0000-000000000012',
  channel: 'sms',
  direction: 'out',
  who: 'Maria Garcia',
  title: 'Outbound text',
  preview: 'Texted Maria the arrival window from my phone.',
  at: '2026-06-04T11:00:00.000Z',
  manuallyLogged: true,
  loggedByName: 'Test Admin',
};

describe('CustomerCommunicationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = false;
  });

  it('renders the unified timeline: titles, job pills, one no-job pill, transactional chip', async () => {
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);

    // All three channel rows render by title.
    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.getByText('Estimate E00012 — ready for review')).toBeInTheDocument();
    expect(screen.getByText('Text message')).toBeInTheDocument();

    // Fetched from the per-customer aggregation endpoint.
    expect(mockApi.get).toHaveBeenCalledWith(`/api/customers/${CUSTOMER_ID}/communications`);

    // Job pills on the two attributed rows; the job-less SMS gets exactly one
    // muted "no job" pill ("badge it, don't hide it").
    expect(screen.getAllByText('J00018')).toHaveLength(2);
    expect(screen.getAllByText('no job')).toHaveLength(1);

    // Transactional email is chipped.
    expect(screen.getByText('auto · transactional')).toBeInTheDocument();
  });

  it('shows the empty state when the customer has no communications', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);

    expect(
      await screen.findByText('No communication with this customer yet.')
    ).toBeInTheDocument();
  });

  it('opens the call detail drawer when a call row is clicked (comms-enabled)', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));

    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'cs-00000000-0000-0000-0000-000000000001',
    );
  });

  it('opens the SMS conversation drawer when a text row is clicked (comms-enabled)', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));

    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-thread-id', THREAD_ID);
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  // C6b - a logged TEXT must not open the customer's real SMS thread either. Same class as the
  // spec below, different channel, and what proves the gate is on provenance not on channel.
  it('does not open the SMS thread for a hand-logged text, while the platform text beside it still does', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: [...ITEMS, LOGGED_TEXT_ITEM] } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);
    await screen.findByText(LOGGED_TEXT_ITEM.title);

    await user.click(screen.getByText(LOGGED_TEXT_ITEM.title));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();

    await user.click(screen.getByText('Text message'));
    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-thread-id', THREAD_ID);
  });

  // Manual Communication Log - a logged entry opens NOTHING. EntityCallDrawer resolves a
  // CallSession by id and a logged entry's id belongs to another table entirely, so the click
  // would yield a dead-end drawer reading "Couldn't load this call". The platform call is clicked
  // in the SAME spec, so this is a gate on provenance and not a tab that stopped opening drawers.
  it('does not open the call drawer for a hand-logged entry, while the platform call beside it still does', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: [...ITEMS, LOGGED_CALL_ITEM] } });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();

    await user.click(screen.getByText('Inbound call · 4m 07s'));
    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'cs-00000000-0000-0000-0000-000000000001',
    );
  });

  // Email joined call/sms on the per-row reassign seam. This tab is one of the
  // three sibling roll-ups that must all show it - an email that could not be
  // re-attributed while the call and text beside it could was the odd one out.
  it('gives an email row the attach/move/detach menu when gated (customer scope)', async () => {
    commAccess.value = true;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/customers/${CUSTOMER_ID}/communications`) return { data: { items: ITEMS } };
      if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: { jobs: [] } } };
      return { data: {} };
    });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: buildAbility([
        { action: 'read', subject: 'Communication' },
        { action: 'update', subject: 'Communication' },
      ]),
    });

    const emailRow = (await screen.findByText('Estimate E00012 — ready for review')).closest('li')!;
    expect(
      within(emailRow).getByTitle('Attached to J00018 — click to move or detach')
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CUSTOMER ANCHOR (#2021) — logging a communication ON the customer.
//
// The tab was a read-only roll-up: it could SHOW an entry anchored to one of this customer's
// leads or jobs and could not record one. A conversation about the customer and about no one
// lead or job therefore had nowhere to go, and a customer with neither could not be logged
// against at all.
//
// The button carries the SAME condition the lead and job tabs settled on: the `log_past
// Communication` ability and NOTHING else. Not the phone entitlement - this tab reads
// `useFeature('phone')` for its call and SMS drawers, and inheriting that gate would hide the
// button from exactly the organisations that do their calling elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

const logAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'log_past', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);
const logButton = () => screen.queryByRole('button', { name: /log communication/i });

const PERFORMER_ROSTER = [
  { id: '00000000-0000-0000-0000-000000000001', first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_active: true, has_login: true, department: null },
];

describe('CustomerCommunicationsTab — Log communication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/communication/manual-log/performers'
        ? Promise.resolve({ data: { users: PERFORMER_ROSTER } })
        : Promise.resolve({ data: { items: ITEMS } }),
    );
  });

  it('renders for a user holding the ability', async () => {
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: logAbility,
    });
    await screen.findByText('Inbound call · 4m 07s');

    expect(logButton()).toBeInTheDocument();
  });

  it('does not render for a user without it', async () => {
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: readOnlyAbility,
    });
    await screen.findByText('Inbound call · 4m 07s');

    expect(logButton()).not.toBeInTheDocument();
  });

  // The organisation this feature exists for. Every other control on this tab is behind the
  // phone entitlement; the Log button must not be.
  it('renders for an organisation WITHOUT the phone entitlement', async () => {
    commAccess.value = false;
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: logAbility,
    });
    await screen.findByText('Inbound call · 4m 07s');

    expect(logButton()).toBeInTheDocument();
  });

  // A customer with no leads and no jobs is the case the whole change exists for: on the two
  // sibling tabs there is no surface at all, so this is the ONLY place it can be logged.
  it('renders on a customer with an empty timeline, and says why', async () => {
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/communication/manual-log/performers'
        ? Promise.resolve({ data: { users: PERFORMER_ROSTER } })
        : Promise.resolve({ data: { items: [] } }),
    );
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: logAbility,
    });

    expect(await screen.findByText('No communication with this customer yet.')).toBeInTheDocument();
    expect(logButton()).toBeInTheDocument();
    expect(screen.getByText(/log a past call/i)).toBeInTheDocument();
  });

  it('posts the entry anchored on the CUSTOMER, and refreshes the roll-up', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: logAbility,
    });
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(logButton()!);
    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    const time = screen.getByPlaceholderText('Time');
    await user.clear(time);
    await user.type(time, '4p');
    await user.tab();
    await user.type(
      screen.getByPlaceholderText(/what was discussed/i),
      'Rang Linda to check she was happy with the work.',
    );
    await user.click(screen.getByRole('button', { name: /^log communication$/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/manual-log', {
        // The ONE key that differs from the lead and job call sites. No lead_id, no job_id -
        // naming two would be the state both the API and the database CHECK refuse.
        customer_id: CUSTOMER_ID,
        channel: 'call',
        direction: 'out',
        // The zoneless wall clock, exactly as the two sibling tabs post it. The browser's zone
        // is never consulted; the server composes against the organisation's.
        occurred_at: '2026-08-26T16:00',
        notes: 'Rang Linda to check she was happy with the work.',
        performed_by: '00000000-0000-0000-0000-000000000001',
      }),
    );
    const sent = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('lead_id');
    expect(sent).not.toHaveProperty('job_id');

    // …and the roll-up reloads, so the entry appears without a manual refresh.
    await waitFor(() =>
      expect(
        mockApi.get.mock.calls.filter((c) => c[0] === `/api/customers/${CUSTOMER_ID}/communications`)
          .length,
      ).toBeGreaterThan(1),
    );
  });

  // The correction path, which this tab had no route to at all: a logged row's click already
  // opens NOTHING here (it must not reach the call drawer or the SMS thread), so without this it
  // is a record nobody can fix from the page it was created on.
  it('opens the edit drawer on a logged row for the user who may change it', async () => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/manual-log/performers')
        return Promise.resolve({ data: { users: PERFORMER_ROSTER } });
      if (url === `/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`)
        return Promise.resolve({
          data: {
            entry: {
              id: LOGGED_CALL_ITEM.id,
              channel: 'call',
              direction: 'out',
              occurredAt: '2026-06-04T10:00:00.000Z',
              occurredAtLocal: '2026-06-04T06:00',
              notes: LOGGED_CALL_ITEM.preview,
              durationMinutes: null,
              subject: null,
              leadId: null,
              jobId: null,
              customerId: CUSTOMER_ID,
              performedBy: '00000000-0000-0000-0000-000000000001',
              loggedBy: '00000000-0000-0000-0000-000000000001',
              manuallyLogged: true,
            },
          },
        });
      // `loggedById` is what makes THIS viewer the entry's logger. Without it
      // `canModifyLoggedEntry` fails closed and the row correctly offers nothing, which is a
      // different behaviour from the one under test - so the fixture carries it explicitly.
      return Promise.resolve({
        data: {
          items: [
            ...ITEMS,
            { ...LOGGED_CALL_ITEM, loggedById: '00000000-0000-0000-0000-000000000001' },
          ],
        },
      });
    });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: logAbility,
    });
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));

    // The drawer, seeded from the stored entry - not the call drawer, which would resolve this
    // id as a CallSession and dead-end.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue(LOGGED_CALL_ITEM.preview)).toBeInTheDocument();

    // …and the "Attached to" control says what it is actually attached to. The label had two
    // arms for three anchors, so a customer-anchored entry read "This job" - naming a record it
    // has no connection to, on the one control whose whole job is to say where the entry lives.
    expect(screen.getByRole('button', { name: 'Attached to' })).toHaveTextContent(/this customer/i);
  });

  // THE RETURN DIRECTION. The picker offered leads and jobs only, so an entry could be re-pointed
  // OFF the customer and never back - a one-way door on the one anchor that has no other surface
  // to be corrected from. Both directions are asserted, on the two tabs, because a change to the
  // shared picker could silently close either one.
  it('moves a customer-anchored entry back onto one of that customer\'s leads', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: { id: LOGGED_CALL_ITEM.id } } });
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/manual-log/performers')
        return Promise.resolve({ data: { users: PERFORMER_ROSTER } });
      if (url === `/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`)
        return Promise.resolve({
          data: {
            entry: {
              id: LOGGED_CALL_ITEM.id,
              channel: 'call',
              direction: 'out',
              occurredAt: '2026-06-04T10:00:00.000Z',
              occurredAtLocal: '2026-06-04T06:00',
              notes: LOGGED_CALL_ITEM.preview,
              durationMinutes: null,
              subject: null,
              leadId: null,
              jobId: null,
              customerId: CUSTOMER_ID,
              performedBy: '00000000-0000-0000-0000-000000000001',
              loggedBy: '00000000-0000-0000-0000-000000000001',
              manuallyLogged: true,
            },
          },
        });
      // The picker's default list: this customer's own open leads, in the WIRE shape the
      // endpoint really returns (`lead_number` / `status`), not the mapped one - `useCustomerLeads`
      // maps and filters it, and a fixture shaped like the output would skip both.
      if (url === `/api/customers/${CUSTOMER_ID}`)
        return Promise.resolve({ data: { customer: { jobs: [] } } });
      if (url === '/api/leads')
        return Promise.resolve({
          data: {
            leads: [
              {
                id: 'e0000000-0000-0000-0000-000000000001',
                lead_number: 'L00007',
                status: 'NEW',
                service_request: 'Two garage doors',
                customer: { first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
              },
            ],
          },
        });
      return Promise.resolve({
        data: {
          items: [
            ...ITEMS,
            { ...LOGGED_CALL_ITEM, loggedById: '00000000-0000-0000-0000-000000000001' },
          ],
        },
      });
    });

    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />, {
      ability: logAbility,
    });
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Attached to' }));
    await user.click(await screen.findByRole('menuitem', { name: /L00007/ }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const body = mockApi.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.lead_id).toBe('e0000000-0000-0000-0000-000000000001');
    expect(body).not.toHaveProperty('customer_id');
  });
});
