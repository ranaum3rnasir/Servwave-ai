// Slice E4-FE (+ verification follow-up) — the Lead page Communication tab reads
// the LEAD union endpoint (GET /api/leads/:id/communications: lead_id-linked ∪
// customer-linked rows) and renders shared CommRows, with the row's own lead
// chip self-link-suppressed. Compose parity with the Job tab: an SMS composer
// (stamps leadId at origin) + a "Call customer" entry, both gated on comms
// access + create:Communication.
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import { useAuthStore } from '@/stores/auth.store';
import type { CommItem } from '@/lib/api/jobCommunications';

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

// Org-level comms access — the composer + "Call customer" render only for
// comms-enabled orgs. Default true; the gating specs flip it off.
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Task B4 — "Call customer" routes through the cross-tab dial handoff into
// the /phone tab, not the legacy in-app GlobalDialer popup.
vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
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

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const OTHER_LEAD_ID = 'e0000000-0000-0000-0000-000000000077';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000042';
// #2046 (R1) - the row's own thread id, the drawer's new key.
const THREAD_ID = 'aa000000-0000-0000-0000-000000000099';
const LEAD_LABEL = 'L00001';
const CUSTOMER_NAME = 'Doe HVAC';
const CUSTOMER_PHONE = '5551234567';

const ITEMS: CommItem[] = [
  {
    // Lead-only call (the row the customer roll-up used to miss).
    id: 'ca000000-0000-0000-0000-000000000011',
    channel: 'call',
    direction: 'out',
    who: '+12125551042',
    title: 'Outbound call · 1m 01s',
    preview: 'Intro call — walked through the service request.',
    at: '2026-06-01T14:32:00.000Z',
    leadId: LEAD_ID,
    leadLabel: LEAD_LABEL,
    answeredBy: 'Dana Reyes',
  },
  {
    // Customer-linked SMS attributed to a job AND another lead.
    id: 'aa000000-0000-0000-0000-000000000011',
    channel: 'sms',
    direction: 'in',
    who: 'Doe HVAC',
    title: 'Text message',
    preview: 'Thursday works for the walkthrough.',
    at: '2026-06-01T14:40:00.000Z',
    jobId: JOB_ID,
    jobLabel: 'J00042',
    leadId: OTHER_LEAD_ID,
    leadLabel: 'L00077',
    threadId: THREAD_ID,
  },
];

// Job-attributed email on the lead's customer - the per-row reassign seam now
// covers this channel too, so it is a menu trigger, not a static pill.
const EMAIL_ITEM: CommItem = {
  id: 'ee000000-0000-0000-0000-000000000011',
  channel: 'email',
  direction: 'out',
  who: 'john@doe.com',
  title: 'Estimate E00042 - ready for review',
  preview: 'Hi John, your estimate is ready for review…',
  at: '2026-06-01T14:50:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
};

// A hand-logged entry (manual communication log). Its channel is `call` - that is what the
// logger recorded - but its id belongs to manual_communication_logs, not call_sessions.
const LOGGED_CALL_ITEM: CommItem = {
  id: '11110000-0000-0000-0000-000000000011',
  channel: 'call',
  direction: 'out',
  who: 'Doe HVAC',
  title: 'Outbound call',
  preview: 'Rang John from my mobile about the two garage doors.',
  at: '2026-06-01T15:00:00.000Z',
  leadId: LEAD_ID,
  leadLabel: LEAD_LABEL,
  manuallyLogged: true,
  loggedByName: 'Test Admin',
  // WHO TYPED IT, by id (slice 8) - what the row's edit affordance is decided from. The literal
  // is the auth-store fixture's own user (setup.ts), i.e. "the viewer logged this one".
  loggedById: '00000000-0000-0000-0000-000000000001',
};

// C6b - the same defect on a different channel. A logged TEXT's `onSelect` arm opens the
// customer's REAL SMS thread, a conversation this entry was never part of.
const LOGGED_TEXT_ITEM: CommItem = {
  id: '11110000-0000-0000-0000-000000000012',
  channel: 'sms',
  direction: 'out',
  who: 'Doe HVAC',
  title: 'Outbound text',
  preview: 'Texted him the arrival window from my phone.',
  at: '2026-06-01T15:10:00.000Z',
  leadId: LEAD_ID,
  leadLabel: LEAD_LABEL,
  manuallyLogged: true,
  loggedByName: 'Test Admin',
  loggedById: '00000000-0000-0000-0000-000000000001',
};

// The composer + call entry need create:Communication (the tab renders behind
// the page's read gate, so the default spec ability carries both).
const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);
// Attribution management (the attach/move/detach menu) gates on update, not create.
const manageAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

function renderTab(
  props: Partial<ComponentProps<typeof LeadCommunicationsTab>> = {},
  renderAbility = ability
) {
  return renderWithProviders(
    <LeadCommunicationsTab
      leadId={LEAD_ID}
      leadLabel={LEAD_LABEL}
      customerId={CUSTOMER_ID}
      customerName={CUSTOMER_NAME}
      customerPhone={CUSTOMER_PHONE}
      {...props}
    />,
    { ability: renderAbility }
  );
}

describe('LeadCommunicationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });
  });

  it('fetches the lead union endpoint and renders the rows (answered-by + chips)', async () => {
    renderTab();

    expect(await screen.findByText('Outbound call · 1m 01s')).toBeInTheDocument();
    expect(screen.getByText('Text message')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(`/api/leads/${LEAD_ID}/communications`);

    // Calls carry the answered-by fragment.
    expect(screen.getByText('· answered by Dana Reyes')).toBeInTheDocument();

    // THIS lead's own chip is plain (self-link suppressed)…
    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(LEAD_LABEL).closest('a')).toBeNull();
    // …while another lead's chip and the job pill navigate.
    expect(screen.getByText('L00077').closest('a')).toHaveAttribute(
      'href',
      `/leads/${OTHER_LEAD_ID}`
    );
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${JOB_ID}`);
  });

  it('sends a lead-stamped text from the composer and clears it on success', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Outbound call · 1m 01s');

    const textarea = screen.getByPlaceholderText(/text doe hvac/i);
    await user.type(textarea, 'Thanks — booking you in.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        customerId: CUSTOMER_ID,
        body: 'Thanks — booking you in.',
        leadId: LEAD_ID,
      })
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('"Call customer" routes into the /phone tab with full lead attribution', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Outbound call · 1m 01s');

    await user.click(screen.getByRole('button', { name: /call customer/i }));

    expect(mockRequestCall).toHaveBeenCalledWith(CUSTOMER_PHONE, {
      leadId: LEAD_ID,
      leadLabel: LEAD_LABEL,
      customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME,
    });
  });

  it('hides the composer + call without org comms access (read-only timeline)', async () => {
    commAccess.value = false;
    renderTab();

    expect(await screen.findByText('Outbound call · 1m 01s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/text doe hvac/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides the composer + call for a read-only user (no create:Communication)', async () => {
    renderTab({}, readOnlyAbility);

    expect(await screen.findByText('Outbound call · 1m 01s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides "Call customer" when the customer has no phone (composer still renders)', async () => {
    renderTab({ customerPhone: undefined });
    await screen.findByText('Outbound call · 1m 01s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('shows the empty state when the lead has no communications', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });
    renderTab();

    expect(
      await screen.findByText('No communication on this lead yet.')
    ).toBeInTheDocument();
  });

  it('opens the call detail drawer when a call row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Outbound call · 1m 01s');

    await user.click(screen.getByText('Outbound call · 1m 01s'));

    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'ca000000-0000-0000-0000-000000000011',
    );
  });

  it('opens the SMS conversation drawer (keyed by the row thread id) when a text row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));

    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-thread-id', THREAD_ID);
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  // #2046 (R1) - the drawer re-sources off the row's own thread id, not the tab's customer, so a
  // text row with no thread id (e.g. an inbound row never attached to a MessageThread) stays a
  // row. The tab's own `customerId` prop no longer decides this.
  it('does not make text rows clickable when the row carries no thread id', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({
      data: { items: [{ ...ITEMS[0] }, { ...ITEMS[1], threadId: undefined }] },
    });
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
  });

  // C6b - a logged TEXT must not open the customer's real SMS thread either. Same class as the
  // spec below, different channel: the entry was never part of that conversation. This is what
  // proves the gate is on provenance rather than on `channel === 'call'`.
  it('does not open the SMS thread for a hand-logged text, while the platform text beside it still does', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: [...ITEMS, LOGGED_TEXT_ITEM] } });
    renderTab();
    await screen.findByText(LOGGED_TEXT_ITEM.title);

    await user.click(screen.getByText(LOGGED_TEXT_ITEM.title));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();

    await user.click(screen.getByText('Text message'));
    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-thread-id', THREAD_ID);
  });

  // Manual Communication Log - a logged entry is NOT a platform record, and clicking one must
  // not pretend otherwise. EntityCallDrawer resolves a CallSession by id; a manual entry's id
  // belongs to manual_communication_logs, so GET /api/communication/calls/<that id> is a 404 and
  // the click yields a drawer reading "Couldn't load this call".
  //
  // The platform call is clicked in the SAME spec, so this is a gate on provenance rather than a
  // tab that stopped opening drawers at all.
  it('does not open the call drawer for a hand-logged entry, while the platform call beside it still does', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: [...ITEMS, LOGGED_CALL_ITEM] } });
    renderTab();
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();

    await user.click(screen.getByText('Outbound call · 1m 01s'));
    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'ca000000-0000-0000-0000-000000000011',
    );
  });

  // Email joined call/sms on the per-row reassign seam. All three sibling
  // roll-ups must show it; here the customer scope comes from the lead's
  // converted customer, so an unconverted lead correctly keeps a static pill.
  it('gives an email row the attach/move/detach menu when the lead has a customer', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/leads/${LEAD_ID}/communications`)
        return { data: { items: [...ITEMS, EMAIL_ITEM] } };
      if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: { jobs: [] } } };
      return { data: {} };
    });
    renderTab({}, manageAbility);

    const emailRow = (await screen.findByText('Estimate E00042 - ready for review')).closest('li')!;
    expect(
      within(emailRow).getByTitle('Attached to J00042 — click to move or detach')
    ).toBeInTheDocument();
  });

  // Was "keeps the email pill static when the lead has no customer scope". A
  // missing customer no longer kills the control — it switches the picker into
  // search mode, because rows with no customer are exactly the ones that need
  // manual attribution and the API has always accepted it.
  it('keeps the email pill live (search mode) when the lead has no customer scope', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [EMAIL_ITEM] } });
    renderTab({ customerId: undefined }, manageAbility);

    const emailRow = (await screen.findByText('Estimate E00042 - ready for review')).closest('li')!;
    expect(
      within(emailRow).getByTitle('Attached to J00042 — click to move or detach')
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual Communication Log (slice 1) — the Log communication entry point.
//
// PLACEMENT IS THE POINT AND IT IS NOT DEFERRABLE. The composer's row renders only when the org
// has the phone entitlement AND the user holds create:Communication AND the lead has a resolved
// customer. The Log button must inherit NONE of those three, or it disappears for exactly the
// organisations this feature exists for (no ServWave Phone, no number provisioned) and for leads
// with no customer attached yet. It therefore gets its OWN always-rendered row, shown whenever
// the user holds the new ability.
// ─────────────────────────────────────────────────────────────────────────────

const logAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
  { action: 'log_past', subject: 'Communication' },
]);
/** Holds the logging ability and nothing else that renders chrome - the non-phone org's user. */
const logOnlyAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'log_past', subject: 'Communication' },
]);

const logButton = () => screen.queryByRole('button', { name: /log communication/i });

describe('LeadCommunicationsTab — Log communication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });
  });

  it('renders for a user holding the ability', async () => {
    renderTab({}, logAbility);
    await screen.findByText('Outbound call · 1m 01s');

    expect(logButton()).toBeInTheDocument();
  });

  it('does not render for a user without it, who keeps the composer', async () => {
    renderTab({}, ability);
    await screen.findByText('Outbound call · 1m 01s');

    expect(logButton()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('renders for an organisation WITHOUT the phone entitlement, where nothing else does', async () => {
    commAccess.value = false;
    renderTab({}, logOnlyAbility);
    await screen.findByText('Outbound call · 1m 01s');

    expect(logButton()).toBeInTheDocument();
    // The three composer conditions all fail here; the Log row is unaffected by every one.
    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('renders on a lead with NO customer attached', async () => {
    renderTab({ customerId: undefined, customerPhone: undefined }, logAbility);
    await screen.findByText('Outbound call · 1m 01s');

    expect(logButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  // "Its own row" is a statement about the RENDER CONDITION, not about DOM nesting: the row now
  // renders whenever EITHER control applies, and each control carries its own condition. Where
  // both apply they sit side by side and are equally reachable (user story 44); the two specs
  // above are what prove the Log button survives when the composer's conditions all fail.
  it('sits beside Call customer where that exists, equally reachable', async () => {
    renderTab({}, logAbility);
    await screen.findByText('Outbound call · 1m 01s');

    const callBtn = screen.getByRole('button', { name: /call customer/i });
    expect(logButton()).toBeInTheDocument();
    expect(logButton()!.parentElement).toBe(callBtn.parentElement);
  });

  it('tells a reader with the ability that past communications can be logged, on the empty state', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });
    renderTab({}, logAbility);

    expect(await screen.findByText('No communication on this lead yet.')).toBeInTheDocument();
    expect(screen.getByText(/log a past call/i)).toBeInTheDocument();
  });
});

// The signed-in user, per the shared auth-store mock in __tests__/setup.ts, and a colleague
// whose conversation the admin is typing up - the feature's primary use case.
const CURRENT_USER_ID = '00000000-0000-0000-0000-000000000001';
const COLLEAGUE_ID = '00000000-0000-0000-0000-000000000003';
const ROSTER = [
  { id: CURRENT_USER_ID, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_active: true, has_login: true, department: null },
  { id: COLLEAGUE_ID, first_name: 'Dana', last_name: 'Reyes', role: 'SALES', is_active: true, has_login: true, department: null },
];

const performerPicker = () => screen.getByRole('combobox', { name: /who had the conversation/i });

describe('LeadCommunicationsTab — the log drawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    // The drawer's performer picker reads its OWN capability-scoped roster - NOT `/api/users`,
    // which is gated on `read User` and 403s for a SALES user holding only `log_past`. The
    // timeline reads the lead.
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/communication/manual-log/performers'
        ? Promise.resolve({ data: { users: ROSTER } })
        : Promise.resolve({ data: { items: ITEMS } })
    );
  });

  async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
    renderTab({}, logAbility);
    await screen.findByText('Outbound call · 1m 01s');
    await user.click(logButton()!);
    return screen.getByRole('dialog');
  }

  it('requires direction, occurred-at and notes before it will save', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    const save = screen.getByRole('button', { name: /^log communication$/i });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    expect(save).toBeDisabled();

    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    expect(save).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Quoted two garage doors.');
    expect(save).toBeEnabled();
  });

  // THE ORG-CLOCK CONTRACT, from the client's side: the drawer posts the ZONELESS wall clock the
  // user picked and never converts it. Converting here would resolve it against the BROWSER's
  // zone - the recurring bug this feature must not ship - so the browser's zone is simply never
  // consulted, and the server composes against the organisation's.
  it('posts the picked wall clock verbatim, with no zone applied, and refreshes the timeline', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
    await openDrawer(user);

    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    const time = screen.getByPlaceholderText('Time');
    await user.clear(time);
    await user.type(time, '4p');
    await user.tab();
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Quoted two garage doors.');
    await user.click(screen.getByRole('button', { name: /^log communication$/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/manual-log', {
        lead_id: LEAD_ID,
        // The channel picker's default (slice 6), sent explicitly for the same reason the
        // performer below is: the entry's channel is a stated fact of the record, not something
        // the server should have to fall back on a column default for.
        channel: 'call',
        direction: 'out',
        occurred_at: '2026-08-26T16:00',
        notes: 'Quoted two garage doors.',
        // The picker's default, sent explicitly: the user who had the conversation is a stated
        // fact of the entry, not something the server should have to infer.
        performed_by: CURRENT_USER_ID,
      })
    );
    // No instant, no zone designator - the browser never decided which day this was.
    const sent = mockApi.post.mock.calls[0][1] as { occurred_at: string };
    expect(sent.occurred_at).not.toMatch(/[Zz]|[+-]\d{2}:\d{2}$/);

    // The timeline reloads, so the new entry appears without a manual refresh.
    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith(`/api/leads/${LEAD_ID}/communications`)
    );
    expect(mockApi.get.mock.calls.filter((c) => c[0] === `/api/leads/${LEAD_ID}/communications`).length)
      .toBeGreaterThan(1);
  });

  it('records an inbound communication when the user says the customer called us', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
    await openDrawer(user);

    await user.click(screen.getByRole('radio', { name: 'Inbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'They chased the quote.');
    await user.click(screen.getByRole('button', { name: /^log communication$/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/communication/manual-log',
        expect.objectContaining({ direction: 'in' })
      )
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2 — crediting the colleague who had the conversation.
//
// The feature's primary use case is an onboarding admin typing up conversations OTHER PEOPLE
// had. Without this picker every one of those entries credits the typist, which is the wrong
// person on the record that matters most to the feature.
//
// The logger has no picker and never will: it is what tells an eyewitness record from a
// second-hand one, so a user able to choose it could disown their own entry.
// ─────────────────────────────────────────────────────────────────────────────
describe('LeadCommunicationsTab — who had the conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/communication/manual-log/performers'
        ? Promise.resolve({ data: { users: ROSTER } })
        : Promise.resolve({ data: { items: ITEMS } })
    );
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
  });

  async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
    renderTab({}, logAbility);
    await screen.findByText('Outbound call · 1m 01s');
    await user.click(logButton()!);
  }

  async function fillAndSave(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Quoted two garage doors.');
    await user.click(screen.getByRole('button', { name: /^log communication$/i }));
  }

  it('defaults to the current user', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await waitFor(() => expect(performerPicker()).toHaveTextContent('Test Admin'));
  });

  it('offers the organisation\'s other users and credits the one chosen', async () => {
    const user = userEvent.setup();
    await openDrawer(user);
    await waitFor(() => expect(performerPicker()).toHaveTextContent('Test Admin'));

    await user.click(performerPicker());
    await user.click(await screen.findByRole('option', { name: /Dana Reyes/ }));
    await fillAndSave(user);

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/communication/manual-log',
        expect.objectContaining({ performed_by: COLLEAGUE_ID })
      )
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WHERE THE ROSTER COMES FROM (slice 4, C1). It used to come from `GET /api/users`, which is
  // gated on `read User` — a grant that appears in DEFAULT_GRANTS exactly twice, for DISPATCHER
  // and TECHNICIAN. So the moment an admin granted the logging capability to SALES, the picker
  // 403'd and rendered EMPTY: that user could credit nobody, not even themselves, on a feature
  // that had just been switched on for them. The drawer now reads a roster guarded by the SAME
  // capability, and must not touch the staff directory at all.
  // ───────────────────────────────────────────────────────────────────────────
  it('reads its own capability-scoped roster and never the staff directory', async () => {
    const user = userEvent.setup();
    await openDrawer(user);
    await waitFor(() => expect(performerPicker()).toHaveTextContent('Test Admin'));

    const requested = mockApi.get.mock.calls.map((c) => c[0]);
    expect(requested).toContain('/api/communication/manual-log/performers');
    expect(requested).not.toContain('/api/users');
  });

  it('never lets the caller name the logger', async () => {
    const user = userEvent.setup();
    await openDrawer(user);
    await waitFor(() => expect(performerPicker()).toHaveTextContent('Test Admin'));

    // ONE person picker in the drawer - there is no second control offering the logger.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);

    await fillAndSave(user);

    // …and the wire carries no logger at all: the server takes it from the authenticated
    // principal, and the API refuses a body that names one.
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).not.toHaveProperty('logged_by');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 3 — how the call went.
//
// Two optional details that make an ATTEMPT distinguishable from a CONVERSATION, and a long
// discovery call distinguishable from a thirty-second confirmation. Both stay optional: the
// drawer saves with neither, and every entry logged before this slice existed is unaffected.
// ─────────────────────────────────────────────────────────────────────────────
describe('LeadCommunicationsTab — how the call went', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/communication/manual-log/performers'
        ? Promise.resolve({ data: { users: ROSTER } })
        : Promise.resolve({ data: { items: ITEMS } })
    );
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
  });

  async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
    renderTab({}, logAbility);
    await screen.findByText('Outbound call · 1m 01s');
    await user.click(logButton()!);
  }

  /** Direction + when + notes — everything an entry cannot exist without, and nothing optional. */
  async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Quoted two garage doors.');
  }

  const save = () => screen.getByRole('button', { name: /^log communication$/i });

  // THE UNIT IS STATED WHERE THE QUESTION IS ASKED. It used to live in a `hint` BELOW the input,
  // so at the moment of typing "1" the user's eye was on the label and the unit was out of view.
  // Folded into the label instead - and the hint dropped rather than duplicated. This asserts the
  // LABEL, not merely that the word "minutes" appears somewhere in the drawer: the error message
  // ("a whole number of minutes") would satisfy a looser check while the label said nothing.
  it('asks how long the call was IN MINUTES in the label itself, with no separate hint', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    const duration = screen.getByLabelText(/how long did it last, in minutes\?/i);
    expect(duration).toBeInTheDocument();
    // Still optional, still the same placeholder - only the unit moved.
    expect(screen.getByText(/how long did it last, in minutes\?/i).textContent).toMatch(
      /\(optional\)/i
    );
    expect(duration).toHaveAttribute('placeholder', 'e.g. 12');
    // The hint that used to carry the unit is gone, not repeated under the input.
    expect(screen.queryByText('In minutes.')).not.toBeInTheDocument();
  });

  it('offers a duration in minutes and sends it', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await user.type(screen.getByLabelText(/how long did it last/i), '12');
    await fillRequired(user);
    await user.click(save());

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/communication/manual-log',
        expect.objectContaining({ duration_minutes: 12 })
      )
    );
  });

  // THE OUTCOME QUESTION IS GONE. "How did it go?" and its four pills were removed as a question
  // not worth asking of somebody typing up history they already lived through. The column, the
  // stored entries and the API field all survive untouched - the form simply stops asking, and
  // stops sending, so a call now says nothing about how it went unless the notes do.
  it('no longer asks how the call went, and sends no outcome for one', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    // The channel is a call by default, which is the only channel that ever offered the pills.
    expect(screen.getByRole('radio', { name: 'Call' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/how did it go/i)).not.toBeInTheDocument();
    for (const label of ['Connected', 'No answer', 'Voicemail', 'Callback requested']) {
      expect(screen.queryByRole('radio', { name: label })).not.toBeInTheDocument();
    }

    await user.type(screen.getByLabelText(/how long did it last/i), '12');
    await fillRequired(user);
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    // A complete call entry - channel, direction, when, notes and a duration - and still no key.
    expect(body).toMatchObject({ channel: 'call', duration_minutes: 12 });
    expect(body).not.toHaveProperty('outcome');
  });

  // THE DURATION STAYS OPTIONAL. The entry slice 1 could already record - direction, when,
  // notes - is still a complete entry, and the body carries no duration key rather than a null:
  // an absent field and a field explicitly set to nothing are different statements.
  it('saves with no duration, sending no duration key', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await fillRequired(user);
    expect(save()).toBeEnabled();
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('duration_minutes');
    expect(body).not.toHaveProperty('outcome');
  });

  // The API refuses these independently (that is where the rule lives). The client guard is what
  // stops the user meeting a bare 400 for something the form could see coming.
  it('will not send a duration that is not a whole number of minutes', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await fillRequired(user);
    await user.type(screen.getByLabelText(/how long did it last/i), '2.5');

    expect(screen.getByText(/whole number of minutes/i)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await user.click(save());
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('will not send a negative duration', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await fillRequired(user);
    await user.type(screen.getByLabelText(/how long did it last/i), '-5');

    expect(save()).toBeDisabled();
    await user.click(save());
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 6 — the channel picker.
//
// A rep texts a customer from their own phone and an estimator replies from Outlook; neither
// passes through ServWave, and until now neither could be recorded as what it was. The optional
// fields follow the channel, because they are not merely unused on the wrong one - the timeline
// builds its title out of them, so "Outbound email · 12m" would be a statement about a
// conversation that never had a length.
// ─────────────────────────────────────────────────────────────────────────────
describe('LeadCommunicationsTab — which channel it happened on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/communication/manual-log/performers'
        ? Promise.resolve({ data: { users: ROSTER } })
        : Promise.resolve({ data: { items: ITEMS } })
    );
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
  });

  async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
    renderTab({}, logAbility);
    await screen.findByText('Outbound call · 1m 01s');
    await user.click(logButton()!);
  }

  async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Quoted two garage doors.');
  }

  const save = () => screen.getByRole('button', { name: /^log communication$/i });
  const channel = (name: string) => screen.getByRole('radio', { name });

  it('offers the three supported channels and nothing else', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    for (const name of ['Call', 'Text', 'Email']) {
      expect(channel(name)).toBeInTheDocument();
    }
    // In-person, voicemail-left, letters and walk-ins are explicitly out of scope - they have no
    // slot in the shared timeline-item contract.
    for (const name of [/in person/i, /voicemail left/i, /letter/i, /walk.?in/i, /whatsapp/i]) {
      expect(screen.queryByRole('radio', { name })).not.toBeInTheDocument();
    }
  });

  it('logs a call by default, so an entry saved without touching the picker is what it always was', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await fillRequired(user);
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({ channel: 'call' });
  });

  it('sends a logged TEXT, and stops offering a duration - a text has no length', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await user.click(channel('Text'));

    expect(screen.queryByLabelText(/how long did it last/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/subject/i)).not.toBeInTheDocument();

    await fillRequired(user);
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ channel: 'sms' });
    expect(body).not.toHaveProperty('duration_minutes');
    expect(body).not.toHaveProperty('outcome');
    expect(body).not.toHaveProperty('subject');
  });

  it('sends a logged EMAIL with its subject line, and offers no duration', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await user.click(channel('Email'));

    expect(screen.queryByLabelText(/how long did it last/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/subject/i), 'Revised scope - two garage doors');
    await fillRequired(user);
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({
      channel: 'email',
      subject: 'Revised scope - two garage doors',
    });
  });

  // OPTIONAL, like every other field the channel makes available. Somebody typing up months of
  // history will not remember every subject line, and an email without one is a complete entry.
  it('saves an email with no subject, sending no subject key at all', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await user.click(channel('Email'));
    await fillRequired(user);
    expect(save()).toBeEnabled();
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).not.toHaveProperty('subject');
  });

  // C10 — AND THE FIELDS THAT ARE NOT THE CHANNEL'S BUSINESS DO SURVIVE IT.
  //
  // `pickChannel` clears three fields. Nothing pinned WHICH three: a mutation that made it wipe
  // the notes and the direction as well left the whole tab suite green. That was tolerable while
  // this form only ever created an entry — a user who had just opened it had typed little. Slice
  // 8 reopens the same form on an entry that already exists, where a channel correction silently
  // discarding somebody's paragraph of notes is a real loss of their work.
  //
  // Notes and direction are asserted THROUGH THE POST rather than off the textarea, so this
  // cannot pass on a field that still displays a value the mutation no longer sends.
  it('keeps the notes and the direction across a change of channel', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await user.click(screen.getByRole('radio', { name: 'Inbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    const notes = 'He rang to say the second door frame is out of square and needs re-measuring.';
    await user.type(screen.getByPlaceholderText(/what was discussed/i), notes);

    // Round the houses: call -> text -> email -> call. Whatever the channel ends up being, what
    // was said and who called whom are facts about the conversation, not about the medium.
    await user.click(channel('Text'));
    await user.click(channel('Email'));
    await user.click(channel('Call'));

    expect(screen.getByPlaceholderText(/what was discussed/i)).toHaveValue(notes);
    expect(screen.getByRole('radio', { name: 'Inbound' })).toHaveAttribute('aria-checked', 'true');

    expect(save()).toBeEnabled();
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({
      channel: 'call',
      direction: 'in',
      notes,
    });
  });

  // THE FIELDS DO NOT SURVIVE A CHANGE OF MIND. A user who typed a duration, then realised it was
  // an email, must not silently post a 12-minute email - the API refuses one, and the honest
  // reading is that the answer no longer applies rather than that it is hidden but still true.
  it('drops a duration typed on a call when the channel changes to email, and vice versa', async () => {
    const user = userEvent.setup();
    await openDrawer(user);

    await user.type(screen.getByLabelText(/how long did it last/i), '12');
    await user.click(channel('Email'));
    await user.type(screen.getByLabelText(/subject/i), 'Revised scope');
    await user.click(channel('Call'));

    // Back on a call: the duration the user typed is gone, not restored.
    expect(screen.getByLabelText(/how long did it last/i)).toHaveValue(null);

    await fillRequired(user);
    await user.click(save());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ channel: 'call' });
    expect(body).not.toHaveProperty('subject');
    expect(body).not.toHaveProperty('duration_minutes');
    expect(body).not.toHaveProperty('outcome');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTING AND REMOVING A LOGGED ENTRY (slice 8).
//
// Clicking a logged row is what slice 6's gate was holding open: it routed a manual-log id into
// EntityCallDrawer, which resolves a CallSession, so the gate turned the click off rather than
// letting it 404. It now has a real destination — the same drawer, reopened on the entry.
//
// The affordance exists ONLY for somebody who may actually change it: the logger, or an
// organisation admin, holding the ability. A row offering an edit that 403s is worse than a row
// offering nothing.
// ─────────────────────────────────────────────────────────────────────────────

const OTHER_USER_ID = '00000000-0000-0000-0000-000000000003';

/** The entry as the editor's read returns it — full notes, and the ORG's wall clock. */
const STORED_ENTRY = {
  id: LOGGED_CALL_ITEM.id,
  channel: 'call',
  direction: 'out',
  occurredAt: '2026-06-01T15:00:00.000Z',
  occurredAtLocal: '2026-06-01T11:00',
  notes: 'Rang John from my mobile about the two garage doors, and the frame he wants re-measured.',
  durationMinutes: 12,
  outcome: 'connected',
  subject: null,
  leadId: LEAD_ID,
  jobId: null,
  performedBy: CURRENT_USER_ID,
  loggedBy: CURRENT_USER_ID,
  manuallyLogged: true,
};

function mockEditFetches(entry: Record<string, unknown> = STORED_ENTRY, items = [LOGGED_CALL_ITEM]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/communication/manual-log/performers') return Promise.resolve({ data: { users: ROSTER } });
    if (url === `/api/communication/manual-log/${entry.id}`) {
      return Promise.resolve({ data: { entry } });
    }
    if (url === `/api/customers/${CUSTOMER_ID}`) {
      return Promise.resolve({
        data: { customer: { jobs: [{ id: JOB_ID, job_number: 'J00042', status: 'SCHEDULED' }] } },
      });
    }
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    return Promise.resolve({ data: { items } });
  });
}

/** A viewer who is neither an admin nor the logger — the third party in the rule. */
function viewAsColleague() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: OTHER_USER_ID,
        email: 'sales@test.com',
        first_name: 'Test',
        last_name: 'Sales',
        role: 'SALES',
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

describe('LeadCommunicationsTab — correcting a logged entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockEditFetches();
  });

  const editDrawer = () => screen.queryByRole('heading', { name: /edit logged communication/i });

  it('reopens the drawer on the entry, seeded from the stored record and not from the row', async () => {
    const user = userEvent.setup();
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));

    await waitFor(() => expect(editDrawer()).toBeInTheDocument());
    // The FULL notes, not the row's 160-character preview.
    expect(screen.getByPlaceholderText(/what was discussed/i)).toHaveValue(STORED_ENTRY.notes);
    expect(screen.getByRole('radio', { name: 'Outbound' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Call' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/how long did it last/i)).toHaveValue(12);
    // The entry stores `outcome: 'connected'` and the form no longer has anywhere to put it: the
    // question was retired, so a correction neither shows it nor offers to change it.
    expect(screen.queryByText(/how did it go/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Connected' })).not.toBeInTheDocument();
    // …and it never opens the PLATFORM call drawer, which slice 6's gate was there to prevent.
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  // A correction of a CALL that stays a call. The drawer USED to re-send the stored outcome here,
  // because the PUT is a replacement and omitting the key cleared the column. The field is now
  // RETIRED end to end: the API's schema is `.strict()`, so a body still naming it is a 400 on a
  // field the user cannot see - which would make every correction of a legacy entry fail.
  //
  // THE FIXTURE STILL CARRIES ONE. `STORED_ENTRY.outcome` is 'connected', which is what makes
  // this able to fail: the old drawer read that value and put it on the wire. An entry with no
  // stored outcome would send nothing under either version and would prove nothing.
  it('sends no outcome when correcting a call entry that stored one', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());

    await user.clear(screen.getByPlaceholderText(/what was discussed/i));
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Corrected the notes.');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const body = mockApi.put.mock.calls[0][1] as Record<string, unknown>;
    // Everything the drawer DOES capture still rides the correction…
    expect(body).toMatchObject({
      channel: 'call',
      duration_minutes: 12,
      notes: 'Corrected the notes.',
    });
    // …and the retired field is absent, not null.
    expect(body).not.toHaveProperty('outcome');
  });

  // The same, through the channel change that used to have its own rule. The duration IS still
  // dropped here - that field is live, and `pickChannel` clears it because a duration is a fact
  // about a call. The outcome is absent for the different reason above: nothing reads it at all.
  it('sends no outcome when the correction changes the channel away from a call', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());

    await user.click(screen.getByRole('radio', { name: 'Text' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const body = mockApi.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ channel: 'sms' });
    expect(body).not.toHaveProperty('outcome');
    expect(body).not.toHaveProperty('duration_minutes');
  });

  // The org clock, from the client's side: the picker reopens on the WALL CLOCK the server
  // composed against the organisation's zone, and posts it back verbatim. Deriving it here from
  // `occurredAt` would resolve the instant against the BROWSER's zone, and saving an untouched
  // form would then move the entry.
  it('reopens on the organisation’s wall clock and sends it back unchanged', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const [url, body] = mockApi.put.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`);
    expect(body.occurred_at).toBe('2026-06-01T11:00');
    // No instant, no zone designator — the browser never decided which day this was.
    expect(body.occurred_at).not.toMatch(/[Zz]|[+-]\d{2}:\d{2}$/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WHOSE CONVERSATION IT WAS, on reopening. The one defect on this feature the SERVER cannot
  // catch: seeding the performer from the EDITING USER rather than from the ENTRY sends a
  // perfectly valid user id — just the wrong person's — so an admin correcting a colleague's
  // typo would silently re-credit the conversation to themselves. That is precisely what the
  // attribution design exists to prevent (user stories 10 and 11).
  //
  // Every other editor fixture in this file sets `performedBy` to the CURRENT user, so seeding
  // from either source produces an identical result and the mutation stays green. This entry is
  // deliberately Dana's, and the admin is the one opening it.
  // ─────────────────────────────────────────────────────────────────────────
  it('seeds the performer from the ENTRY, not from whoever is doing the editing', async () => {
    const user = userEvent.setup();
    mockEditFetches({ ...STORED_ENTRY, performedBy: COLLEAGUE_ID });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());

    expect(performerPicker()).toHaveTextContent('Dana Reyes');
    expect(performerPicker()).not.toHaveTextContent('Test Admin');
  });

  it('saves a colleague\u2019s entry still credited to the colleague, untouched', async () => {
    const user = userEvent.setup();
    mockEditFetches({ ...STORED_ENTRY, performedBy: COLLEAGUE_ID });
    mockApi.put.mockResolvedValue({ data: { entry: STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());

    // Nothing about WHO is touched - only the notes. The correction must not move the credit.
    await user.clear(screen.getByPlaceholderText(/what was discussed/i));
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Corrected the date only.');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const body = mockApi.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.performed_by).toBe(COLLEAGUE_ID);
    expect(body.performed_by).not.toBe(CURRENT_USER_ID);
  });

  it('sends the whole editable record, so a cleared field is cleared and not retained', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());

    // It was an email, not a call — the call-shaped answers no longer apply.
    await user.click(screen.getByRole('radio', { name: 'Email' }));
    await user.type(screen.getByLabelText(/subject/i), 'Revised scope');
    await user.click(screen.getByRole('radio', { name: 'Inbound' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const body = mockApi.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      lead_id: LEAD_ID,
      channel: 'email',
      direction: 'in',
      notes: STORED_ENTRY.notes,
      performed_by: CURRENT_USER_ID,
      subject: 'Revised scope',
    });
    // The duration the entry carried as a call is GONE from the payload, so the server stores
    // NULL — a 12-minute email would render as "Outbound email · 12m", a statement about a
    // conversation that never had a length. (The outcome is absent on every path now: the field
    // is retired; see the two tests above.)
    expect(body).not.toHaveProperty('duration_minutes');
    expect(body).not.toHaveProperty('outcome');
    // The logger is never sent. The API refuses a body naming it.
    expect(body).not.toHaveProperty('logged_by');
  });

  it('moves the entry onto a job, naming the job and no longer the lead', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /attached to/i }));
    await user.click(await screen.findByText('J00042'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const body = mockApi.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.job_id).toBe(JOB_ID);
    // Exactly one anchor reaches the wire. Naming both is a state this form cannot express.
    expect(body).not.toHaveProperty('lead_id');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REMOVING AN ENTRY ASKS FIRST. What one click destroys is prose somebody typed from memory,
  // often months after the conversation, with no undo and no draft behind it. Every other
  // destructive action in this product confirms through the app's own ConfirmDialog; these three
  // specs pin that this one does too - that Delete alone writes nothing, that declining writes
  // nothing, and that the prompt is the app's dialog rather than the browser's.
  // ─────────────────────────────────────────────────────────────────────────
  /** Open the editor on the logged entry and press its Delete control. */
  async function openAndPressDelete(user: ReturnType<typeof userEvent.setup>) {
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() => expect(editDrawer()).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /delete/i }));
  }

  it('asks before deleting, and writes nothing until the prompt is answered', async () => {
    const user = userEvent.setup();
    const browserConfirm = vi.spyOn(window, 'confirm');
    mockApi.delete.mockResolvedValue({ data: {} });

    await openAndPressDelete(user);

    expect(await screen.findByText('Delete this logged entry?')).toBeInTheDocument();
    expect(mockApi.delete).not.toHaveBeenCalled();
    // The app's own dialog, not the browser's - which jsdom would answer for us silently.
    expect(browserConfirm).not.toHaveBeenCalled();
  });

  it('leaves the entry alone when the prompt is declined', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: {} });

    await openAndPressDelete(user);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(mockApi.delete).not.toHaveBeenCalled();
    // The editor is still open, so a mis-click costs nothing but the click.
    expect(editDrawer()).toBeInTheDocument();
  });

  it('deletes the entry and refreshes the timeline', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: {} });

    await openAndPressDelete(user);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith(
        `/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`,
      ),
    );
    // The drawer closes and the timeline reloads, so the entry goes without a manual refresh.
    await waitFor(() => expect(editDrawer()).not.toBeInTheDocument());
    expect(
      mockApi.get.mock.calls.filter((c) => c[0] === `/api/leads/${LEAD_ID}/communications`).length,
    ).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ANCHOR MOVE IS SYMMETRIC ACROSS ALL THREE (#2021).
//
// The move picker offered leads and jobs. Once a customer became an anchor that made the move
// ONE-WAY: an entry could be re-pointed off the customer onto a lead, and never back, so an
// entry logged on the wrong record was recoverable in two of the three directions and not the
// third. The customer joins the picker for every anchor, which is what makes "it always belongs
// to exactly one" a rule the user can actually navigate rather than a one-way door.
//
// Asserted through the WIRE BODY, because that is where the move is real: exactly one anchor key
// leaves, and the one it came off is absent rather than sent as null.
// ─────────────────────────────────────────────────────────────────────────────
describe('LeadCommunicationsTab — moving a logged entry onto the customer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockEditFetches();
  });

  it('offers the customer as a move target and re-points the entry onto it', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /edit logged communication/i })).toBeInTheDocument(),
    );

    // It is on the lead it was logged on.
    const attached = screen.getByRole('button', { name: 'Attached to' });
    expect(attached).toHaveTextContent(/this lead/i);

    await user.click(attached);
    await user.click(await screen.findByRole('menuitem', { name: new RegExp(CUSTOMER_NAME, 'i') }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const body = mockApi.put.mock.calls[0][1] as Record<string, unknown>;
    expect(body.customer_id).toBe(CUSTOMER_ID);
    // The lead it came off is ABSENT, not null: naming two anchors is the state the API's count
    // rule and the database CHECK both refuse.
    expect(body).not.toHaveProperty('lead_id');
    expect(body).not.toHaveProperty('job_id');
  });
});

describe('LeadCommunicationsTab — who is offered the correction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockEditFetches();
  });

  it('offers it to the logger', async () => {
    const user = userEvent.setup();
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /edit logged communication/i })).toBeInTheDocument(),
    );
  });

  it('offers it to an organisation admin for an entry somebody else logged', async () => {
    const user = userEvent.setup();
    const someoneElses = { ...LOGGED_CALL_ITEM, loggedById: OTHER_USER_ID };
    mockEditFetches({ ...STORED_ENTRY, loggedBy: OTHER_USER_ID }, [someoneElses]);
    // The auth-store fixture is an ADMIN.
    renderTab({}, logAbility);
    await screen.findByText(someoneElses.title);

    await user.click(screen.getByText(someoneElses.title));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /edit logged communication/i })).toBeInTheDocument(),
    );
  });

  it('does NOT offer it to another user holding the ability who did not log it', async () => {
    const user = userEvent.setup();
    viewAsColleague();
    const someoneElses = { ...LOGGED_CALL_ITEM, loggedById: CURRENT_USER_ID };
    mockEditFetches(STORED_ENTRY, [someoneElses]);
    renderTab({}, logAbility);
    await screen.findByText(someoneElses.title);

    await user.click(screen.getByText(someoneElses.title));

    expect(screen.queryByRole('heading', { name: /edit logged communication/i })).not.toBeInTheDocument();
    // …and it did not fall through to the platform drawer either, which is the slice 6 gate.
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('DOES offer it to that same user for an entry they logged themselves', async () => {
    const user = userEvent.setup();
    viewAsColleague();
    const theirs = { ...LOGGED_CALL_ITEM, loggedById: OTHER_USER_ID };
    mockEditFetches({ ...STORED_ENTRY, loggedBy: OTHER_USER_ID }, [theirs]);
    renderTab({}, logAbility);
    await screen.findByText(theirs.title);

    await user.click(screen.getByText(theirs.title));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /edit logged communication/i })).toBeInTheDocument(),
    );
  });

  it('does not offer it to a user without the ability at all, even on their own entry', async () => {
    const user = userEvent.setup();
    renderTab({}, ability); // read + create, no log_past
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));

    expect(screen.queryByRole('heading', { name: /edit logged communication/i })).not.toBeInTheDocument();
  });

  // FAIL CLOSED. A payload that does not say who logged an entry cannot establish that this
  // viewer did, and an admin is not offered one either: the missing field is a defect, and
  // offering an action on a record the client cannot describe is how a 403 gets rendered as a
  // button.
  it('does not offer it when the row does not say who logged it', async () => {
    const user = userEvent.setup();
    const { loggedById: _dropped, ...anonymous } = LOGGED_CALL_ITEM;
    mockEditFetches(STORED_ENTRY, [anonymous as typeof LOGGED_CALL_ITEM]);
    renderTab({}, logAbility);
    await screen.findByText(anonymous.title);

    await user.click(screen.getByText(anonymous.title));

    expect(screen.queryByRole('heading', { name: /edit logged communication/i })).not.toBeInTheDocument();
  });
});
